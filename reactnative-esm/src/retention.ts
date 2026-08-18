import fs from "fs";
import path from "path";

/**
 * Cache retention.
 *
 * The cache grows with every unique dependency set and had no eviction at all:
 * ~15GB and climbing on production, most of it combined `bundle-deps-<hash>.js`
 * files for dep sets that may never be requested again.
 *
 * Per-package chunk caching changes the economics. A combined bundle is now
 * reassembled from cached chunks in ~2s, so evicting one is cheap; a chunk is
 * what actually took esbuild time, and it is shared across many dep sets. So
 * the budgets are deliberately lopsided: evict combined bundles readily, keep
 * chunks.
 *
 * Deliberate safety properties, learned from deleting ~450 production web
 * bundles by hand earlier:
 *  - only files matching an explicit pattern in one known directory are ever
 *    considered; directories and unknown names are skipped;
 *  - nothing younger than MIN_AGE_MS is touched, so a just-built or in-flight
 *    entry cannot be pulled out from under a request;
 *  - eviction is least-recently-used by atime where the filesystem provides it
 *    (relatime gives read-tracking), falling back to mtime;
 *  - every eviction is logged with size and age, and a dry-run mode reports
 *    without deleting.
 */

export interface SweepGroup {
  label: string;
  dir: string;
  /** Only files whose basename matches are candidates. */
  match: RegExp;
  /** Evict least-recently-used until the group is under this many bytes. */
  budgetBytes: number;
}

export interface SweepResult {
  label: string;
  totalBytes: number;
  evicted: number;
  freedBytes: number;
  keptBytes: number;
}

const MIN_AGE_MS = 60 * 60 * 1000;

function lastUsed(st: fs.Stats): number {
  // atime can be older than mtime on noatime mounts; take the newer signal.
  return Math.max(st.atimeMs || 0, st.mtimeMs || 0);
}

export function sweepGroup(group: SweepGroup, opts: { dryRun?: boolean; now?: number } = {}): SweepResult {
  const now = opts.now ?? Date.now();
  const result: SweepResult = { label: group.label, totalBytes: 0, evicted: 0, freedBytes: 0, keptBytes: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(group.dir, { withFileTypes: true });
  } catch {
    return result;
  }

  const files: { file: string; size: number; used: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !group.match.test(entry.name)) continue;
    const full = path.join(group.dir, entry.name);
    try {
      const st = fs.statSync(full);
      files.push({ file: full, size: st.size, used: lastUsed(st) });
      result.totalBytes += st.size;
    } catch {
      /* vanished mid-sweep */
    }
  }

  if (result.totalBytes <= group.budgetBytes) {
    result.keptBytes = result.totalBytes;
    return result;
  }

  // Oldest-used first.
  files.sort((a, b) => a.used - b.used);
  let live = result.totalBytes;
  for (const f of files) {
    if (live <= group.budgetBytes) break;
    if (now - f.used < MIN_AGE_MS) continue; // never evict something in play
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(f.file);
      } catch {
        continue;
      }
    }
    live -= f.size;
    result.evicted++;
    result.freedBytes += f.size;
    console.log(
      `[retention] ${opts.dryRun ? "would evict" : "evicted"} ${path.basename(f.file)} ` +
        `(${(f.size / 1024 / 1024).toFixed(1)}MB, idle ${((now - f.used) / 3600_000).toFixed(1)}h)`
    );
  }
  result.keptBytes = live;
  return result;
}

/** Budgets are env-overridable so the box's disk, not this file, is the limit. */
export function cacheGroups(cacheDir: string): SweepGroup[] {
  const gb = (n: number) => n * 1024 * 1024 * 1024;
  return [
    {
      label: "combined bundles",
      dir: cacheDir,
      match: /^bundle-deps-.*\.js$/,
      budgetBytes: Number(process.env.ESM_BUDGET_COMBINED_GB ?? 6) > 0 ? gb(Number(process.env.ESM_BUDGET_COMBINED_GB ?? 6)) : gb(6),
    },
    {
      label: "package chunks",
      dir: path.join(cacheDir, "chunks"),
      match: /\.js$/,
      budgetBytes: gb(Number(process.env.ESM_BUDGET_CHUNKS_GB ?? 8)),
    },
    {
      label: "per-package /pkg output",
      dir: cacheDir,
      // Anything not a combined bundle or a prelude: `<pkg>@<ver>[.plat.nvN].js`
      match: /^(?!bundle-deps-|prelude-|nativewind-).*\.js$/,
      budgetBytes: gb(Number(process.env.ESM_BUDGET_PKG_GB ?? 10)),
    },
  ];
}

export function sweepCache(cacheDir: string, opts: { dryRun?: boolean } = {}): SweepResult[] {
  const results = cacheGroups(cacheDir).map((g) => sweepGroup(g, opts));
  for (const r of results) {
    console.log(
      `[retention] ${r.label}: ${(r.totalBytes / 1024 / 1024 / 1024).toFixed(2)}GB -> ` +
        `${(r.keptBytes / 1024 / 1024 / 1024).toFixed(2)}GB (${r.evicted} evicted, ` +
        `${(r.freedBytes / 1024 / 1024 / 1024).toFixed(2)}GB freed)`
    );
  }
  return results;
}
