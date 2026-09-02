import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

/**
 * Disk-cached fetch for package-server responses. Cuts warm native startup
 * from ~15s (re-downloading every chunk per process) to seconds, and doubles
 * as the offline story once a project has run once.
 *
 * Cache classes:
 *  - IMMUTABLE (kept forever): /bundle-deps/<hash>, /prelude/<v>, and /pkg
 *    URLs pinned to an exact x.y.z version. POST /bundle-deps responses are
 *    stored under the same key as the equivalent GET (the CDN negative-caches
 *    the GET 404 that precedes a first build, so the POST is often the only
 *    path that ever sees the body).
 *  - VERSIONLESS /pkg (server resolves a tag): 200s cached for 24h.
 *  - /pkg failures (500): negative-cached for 1h -- these are Node-side
 *    packages the client stubs anyway, and each retry costs the server an
 *    npm-install attempt.
 *
 * Headers the client consumes (X-Externals) are preserved. Disable with
 * RNRUN_NO_PKG_CACHE=1; wipe with `rm -rf ~/.rnrun/pkg-cache`.
 */
// RNRUN_PKG_CACHE_DIR relocates the package cache onto a persistent volume,
// alongside RNRUN_BUNDLE_CACHE_DIR / RNRUN_TOOLS_DIR -- otherwise a container
// whose $HOME is an ephemeral writable layer re-fetches every package on wake.
const CACHE_DIR = process.env.RNRUN_PKG_CACHE_DIR || path.join(os.homedir(), ".rnrun", "pkg-cache");
const KEPT_HEADERS = ["content-type", "x-externals", "x-resolved-version"];
const TTL_VERSIONLESS_MS = 24 * 60 * 60 * 1000;
const TTL_NEGATIVE_MS = 60 * 60 * 1000;

type CacheClass = "immutable" | "versionless" | null;

function classify(url: string): CacheClass {
  if (process.env.RNRUN_NO_PKG_CACHE) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (/^\/bundle-deps\/[0-9a-f]{8,}$/.test(u.pathname)) return "immutable";
  if (/^\/prelude\//.test(u.pathname)) return "immutable";
  if (u.pathname.startsWith("/pkg/")) {
    return /@\d+\.\d+\.\d+(?:[-+][\w.]+)?(?:\/|$)/.test(u.pathname) ? "immutable" : "versionless";
  }
  return null;
}

function fileKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

interface Meta {
  url: string;
  status: number;
  headers: Record<string, string>;
  savedAt: number;
  cacheClass: CacheClass;
}

function readEntry(key: string): { meta: Meta; body: Buffer } | null {
  const bodyFile = path.join(CACHE_DIR, key + ".body");
  const metaFile = path.join(CACHE_DIR, key + ".meta.json");
  try {
    if (!fs.existsSync(bodyFile) || !fs.existsSync(metaFile)) return null;
    const meta: Meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const age = Date.now() - (meta.savedAt || 0);
    if (meta.status !== 200 && age > TTL_NEGATIVE_MS) return null;
    if (meta.status === 200 && meta.cacheClass === "versionless" && age > TTL_VERSIONLESS_MS) return null;
    return { meta, body: fs.readFileSync(bodyFile) };
  } catch {
    return null;
  }
}

function writeEntry(key: string, meta: Meta, body: Buffer): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, key + ".body"), body);
    fs.writeFileSync(path.join(CACHE_DIR, key + ".meta.json"), JSON.stringify(meta));
  } catch {
    // Cache write failure is non-fatal.
  }
}

function keptHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of KEPT_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return headers;
}

export interface CachedFetchStats {
  hits: number;
  misses: number;
}

/** Create a fetch that serves package-server responses from disk. */
export function createCachedFetch(stats?: CachedFetchStats): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method?.toUpperCase() ?? "GET";
    const debug = !!process.env.RNRUN_CACHE_DEBUG;

    // POST /nativewind-css: response is a pure function of the body, so cache
    // by body hash (spares a server tailwind compile per identical input).
    // The body is a gzipped JSON buffer (see project/nativewind.ts); gzip is
    // deterministic for a given input + zlib, so hashing the bytes keys the
    // same compile input to the same entry.
    const nwBody = init?.body;
    if (method === "POST" && /\/nativewind-css$/.test(new URL(url).pathname) && (typeof nwBody === "string" || nwBody instanceof Uint8Array) && !process.env.RNRUN_NO_PKG_CACHE) {
      const key = fileKey(url + "#" + createHash("sha256").update(nwBody).digest("hex"));
      const cached = readEntry(key);
      if (cached && cached.meta.status === 200) {
        if (stats) stats.hits++;
        if (debug) console.warn(`[pkg-cache] HIT (nativewind) ${url}`);
        return new Response(cached.body, { status: 200, headers: cached.meta.headers });
      }
      const res = await fetch(url, init);
      if (res.status === 200) {
        const buf = Buffer.from(await res.arrayBuffer());
        writeEntry(key, { url, status: 200, headers: keptHeaders(res), savedAt: Date.now(), cacheClass: "immutable" }, buf);
        if (stats) stats.misses++;
        return new Response(buf, { status: 200, headers: keptHeaders(res) });
      }
      return res;
    }

    // POST /bundle-deps: store the built bundle under the SAME key as the
    // equivalent GET so later sessions hit disk even when the CDN has
    // negative-cached the GET 404.
    if (method === "POST" && /\/bundle-deps$/.test(new URL(url).pathname) && typeof init?.body === "string") {
      let hash: string | undefined;
      try {
        hash = JSON.parse(init.body).hash;
      } catch {
        /* not JSON */
      }
      if (hash && !process.env.RNRUN_NO_PKG_CACHE) {
        const getUrl = url.replace(/\/bundle-deps$/, `/bundle-deps/${hash}`);
        const key = fileKey(getUrl);
        const cached = readEntry(key);
        if (cached && cached.meta.status === 200) {
          if (stats) stats.hits++;
          if (debug) console.warn(`[pkg-cache] HIT (post) ${getUrl}`);
          return new Response(cached.body, { status: 200, headers: cached.meta.headers });
        }
        const res = await fetch(url, init);
        if (res.status === 200) {
          const buf = Buffer.from(await res.arrayBuffer());
          writeEntry(key, { url: getUrl, status: 200, headers: keptHeaders(res), savedAt: Date.now(), cacheClass: "immutable" }, buf);
          if (stats) stats.misses++;
          if (debug) console.warn(`[pkg-cache] STORE (post) ${getUrl} (${buf.length}B)`);
          return new Response(buf, { status: 200, headers: keptHeaders(res) });
        }
        return res;
      }
      return fetch(input as never, init);
    }

    const cacheClass = method === "GET" ? classify(url) : null;
    if (!cacheClass) {
      if (debug) console.warn(`[pkg-cache] pass-through ${method} ${url}`);
      return fetch(input as never, init);
    }

    const key = fileKey(url);
    const cached = readEntry(key);
    if (cached) {
      if (stats) stats.hits++;
      if (debug) console.warn(`[pkg-cache] HIT (${cached.meta.status}) ${url}`);
      return new Response(cached.body, { status: cached.meta.status, headers: cached.meta.headers });
    }

    const res = await fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status === 200 || (res.status >= 500 && url.includes("/pkg/"))) {
      writeEntry(key, { url, status: res.status, headers: keptHeaders(res), savedAt: Date.now(), cacheClass }, buf);
      if (debug) console.warn(`[pkg-cache] STORE (${res.status}) ${url} (${buf.length}B)`);
    } else if (debug) {
      console.warn(`[pkg-cache] status ${res.status} ${url}`);
    }
    if (stats) stats.misses++;
    return new Response(buf, { status: res.status, headers: keptHeaders(res) });
  }) as typeof fetch;
}
