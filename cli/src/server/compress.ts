import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

/**
 * Bundles are ~13 MB of dev JavaScript and compress about 5x. Sent raw, a
 * phone on mobile data spends seconds to tens of seconds downloading one.
 * Metro's own server compresses too.
 */
export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const value = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding || "";
  return value.split(",").some((token) => {
    const [coding, ...params] = token.trim().toLowerCase().split(";");
    if (coding.trim() !== "gzip") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** The last compressed body per key (one per platform), so a rescan or a
 *  second device doesn't recompress the same bundle. */
const lastByKey = new Map<string, { body: string; gz: Promise<Buffer> }>();

export function gzipCached(key: string, body: string): Promise<Buffer> {
  const hit = lastByKey.get(key);
  if (hit && hit.body === body) return hit.gz;
  // Level 6 (zlib's default) on the thread pool: ~13 MB in well under a second,
  // off the event loop.
  const gz = gzipAsync(Buffer.from(body, "utf8"), { level: 6 });
  lastByKey.set(key, { body, gz });
  gz.catch(() => {
    if (lastByKey.get(key)?.gz === gz) lastByKey.delete(key);
  });
  return gz;
}
