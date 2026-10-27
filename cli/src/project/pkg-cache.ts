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
// x-build-status: the dependency-bundle poll keeps waiting while the server says "building"
// (browser-metro incremental-bundler.ts); dropping it here cut native cold builds short.
// RNRUN_SHARED_CACHE_DIR: a read-only cache one host fills for every project on
// it (orchd mounts it into each container; `rnrun cache-fill` fills it). A new
// project then reads the dependency bundles another project already fetched
// instead of downloading ~175MB and writing it to its own disk -- on the test
// pad that was ~3s per scan, and 10-45s whenever the host disk stalled. Only
// immutable 200s are read from it, and nothing here ever writes to it.
const SHARED_DIR = process.env.RNRUN_SHARED_CACHE_DIR ? path.join(process.env.RNRUN_SHARED_CACHE_DIR, "pkg") : null;
const KEPT_HEADERS = ["content-type", "x-externals", "x-resolved-version", "x-build-status"];
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

function readEntry(key: string, dir = CACHE_DIR): { meta: Meta; body: Buffer } | null {
  const bodyFile = path.join(dir, key + ".body");
  const metaFile = path.join(dir, key + ".meta.json");
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

/** An immutable 200 from the host's shared cache, or null. */
function readShared(key: string): { meta: Meta; body: Buffer } | null {
  if (!SHARED_DIR) return null;
  const entry = readEntry(key, SHARED_DIR);
  return entry && entry.meta.status === 200 && entry.meta.cacheClass === "immutable" ? entry : null;
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

// A disk hit resolves without touching I/O, so a build fed entirely from this
// cache (a woken project whose code changed, or every package already on disk)
// ran start to finish without the event loop turning once: on the test pad the
// Expo Go manifest request waited out both pre-warm builds, 27-32s. One
// macrotask turn per hit lets pending requests in between build stages.
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

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
        await turn();
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
        const cached = readEntry(key) ?? readShared(key);
        if (cached && cached.meta.status === 200) {
          if (stats) stats.hits++;
          await turn();
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
    const cached = readEntry(key) ?? (cacheClass === "immutable" ? readShared(key) : null);
    if (cached) {
      if (stats) stats.hits++;
      await turn();
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

function readMeta(dir: string, key: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, key + ".meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export interface FillResult {
  stored: number;
  present: number;
  skipped: number;
  failed: number;
  /** Not stored this run because `maxNew` was reached. */
  deferred: number;
  pruned: number;
}

/**
 * Fill a shared cache directory (what RNRUN_SHARED_CACHE_DIR points at) with
 * package-server responses, in the same layout every project's own cache uses.
 * Run by the host, never by a project: tenants run untrusted code, so the
 * shared cache only ever holds what this fetched from the package server
 * itself. Only immutable URLs are accepted, each file lands by rename so a
 * project reading it never sees half of one, and entries older than
 * `pruneDays` that are no longer in `urls` are removed. `maxNew` caps how many
 * entries one run stores (list the most wanted first): a dependency bundle is
 * 30-60MB, and a burst of them stalls a host disk that is serving projects.
 */
export async function fillSharedCache(
  dir: string,
  urls: string[],
  options: { pruneDays?: number; maxNew?: number; log?: (msg: string) => void } = {}
): Promise<FillResult> {
  const log = options.log ?? (() => {});
  const pkgDir = path.join(dir, "pkg");
  fs.mkdirSync(pkgDir, { recursive: true });
  const result: FillResult = { stored: 0, present: 0, skipped: 0, failed: 0, deferred: 0, pruned: 0 };
  const wanted = new Set<string>();
  for (const url of urls) {
    if (classify(url) !== "immutable") {
      result.skipped++;
      continue;
    }
    const key = fileKey(url);
    wanted.add(key);
    if (fs.existsSync(path.join(pkgDir, key + ".body")) && readMeta(pkgDir, key)?.status === 200) {
      result.present++;
      continue;
    }
    if (options.maxNew !== undefined && result.stored >= options.maxNew) {
      result.deferred++;
      continue;
    }
    try {
      const res = await fetch(url);
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const meta: Meta = { url, status: 200, headers: keptHeaders(res), savedAt: Date.now(), cacheClass: "immutable" };
      // Body first: readEntry wants both files, so the entry appears only
      // once the meta lands.
      for (const [name, data] of [[key + ".body", body], [key + ".meta.json", JSON.stringify(meta)]] as const) {
        const tmp = path.join(pkgDir, `.${name}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, path.join(pkgDir, name));
      }
      result.stored++;
      log(`stored ${url} (${body.length}B)`);
    } catch (err) {
      result.failed++;
      log(`failed ${url}: ${(err as Error).message}`);
    }
  }
  if (options.pruneDays !== undefined) {
    const cutoff = Date.now() - options.pruneDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(pkgDir)) {
      if (!file.endsWith(".meta.json")) continue;
      const key = file.slice(0, -".meta.json".length);
      if (wanted.has(key)) continue;
      const savedAt = readMeta(pkgDir, key)?.savedAt ?? 0;
      if (savedAt > cutoff) continue;
      // Meta first, so a reader never finds a meta without its body.
      fs.rmSync(path.join(pkgDir, file), { force: true });
      fs.rmSync(path.join(pkgDir, key + ".body"), { force: true });
      result.pruned++;
    }
  }
  return result;
}
