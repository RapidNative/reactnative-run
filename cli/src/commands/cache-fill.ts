import * as fs from "node:fs";
import * as path from "node:path";
import { fillSharedCache } from "../project/pkg-cache.js";
import { fillSharedWorklets } from "../bundler/worklets.js";

export interface CacheFillOptions {
  /** The shared cache directory (what RNRUN_SHARED_CACHE_DIR points at in projects). */
  dir: string;
  /** Exact react-native-worklets versions whose babel plugin to store. */
  worklets: string[];
  /** Remove entries older than this that stdin no longer lists. */
  pruneDays?: number;
  /** Store at most this many new entries per run. */
  maxNew?: number;
}

/**
 * `rnrun cache-fill <dir>`: the host side of RNRUN_SHARED_CACHE_DIR. Reads
 * package-server URLs from stdin (one per line; the host picks the ones many
 * projects fetch), stores each immutable one, and stores the worklets plugin
 * for each version given. Projects only ever read the result.
 */
export async function cacheFillCommand(options: CacheFillOptions): Promise<void> {
  const dir = path.resolve(options.dir);
  const urls = fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const log = (msg: string) => console.log(`[cache-fill] ${msg}`);
  const pkg = await fillSharedCache(dir, urls, { pruneDays: options.pruneDays, maxNew: options.maxNew, log });
  log(`packages: ${pkg.stored} stored, ${pkg.present} already there, ${pkg.skipped} not immutable, ${pkg.failed} failed, ${pkg.deferred} deferred, ${pkg.pruned} pruned`);
  if (options.worklets.length > 0) {
    const tools = fillSharedWorklets(dir, options.worklets, log);
    log(`worklets: stored [${tools.stored.join(", ")}], already there [${tools.present.join(", ")}], failed [${tools.failed.join(", ")}]`);
    if (tools.failed.length > 0) process.exitCode = 1;
  }
  if (pkg.failed > 0) process.exitCode = 1;
}
