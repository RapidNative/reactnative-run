import * as fs from "node:fs";
import * as path from "node:path";
import chokidar, { FSWatcher } from "chokidar";
import type { ContentChange } from "browser-metro";
import { shouldSkip, diskToVfs } from "./scan.js";
import { isAssetPath } from "./assets.js";

/** Config files whose change invalidates more than the module graph -- the
 *  whole session must be re-initialized. */
const REINIT_RE = /^\/(package\.json|tsconfig\.json|app\.json|app\.config\.(js|ts)|\.env(\..+)?|tailwind\.config\..+|babel\.config\..+)$/;

export interface FlushResult {
  /** Text-file changes to feed the bundler. */
  changes: ContentChange[];
  /** True when a config file changed and the session must re-initialize. */
  needsReinit: boolean;
  /** Asset paths that changed on disk (served lazily -- no rebuild needed). */
  assetChanges: string[];
}

/**
 * Diff a set of pending VFS paths against the disk. Pure logic, exported for
 * tests; the chokidar wiring below only accumulates paths and debounces.
 */
export function diffPending(
  rootDir: string,
  pending: Set<string>,
  vfsHas: (p: string) => boolean
): FlushResult {
  const changes: ContentChange[] = [];
  const assetChanges: string[] = [];
  let needsReinit = false;

  for (const vfsPath of pending) {
    if (REINIT_RE.test(vfsPath)) needsReinit = true;
    if (isAssetPath(vfsPath)) {
      assetChanges.push(vfsPath);
      continue;
    }
    const diskPath = path.join(rootDir, vfsPath.slice(1));
    let content: string | null = null;
    try {
      content = fs.readFileSync(diskPath, "utf8");
    } catch {
      content = null; // gone from disk
    }
    if (content === null) {
      if (vfsHas(vfsPath)) changes.push({ path: vfsPath, type: "delete" });
    } else if (vfsHas(vfsPath)) {
      changes.push({ path: vfsPath, type: "update", content });
    } else {
      changes.push({ path: vfsPath, type: "create", content });
    }
  }

  return { changes, needsReinit, assetChanges };
}

export interface WatchOptions {
  rootDir: string;
  vfsHas: (p: string) => boolean;
  onFlush: (result: FlushResult) => Promise<void>;
  debounceMs?: number;
}

export interface ProjectWatcher {
  close(): Promise<void>;
}

/**
 * Watch the project directory and deliver debounced, diffed change batches.
 * A flush that arrives while a build is running re-arms instead of
 * overlapping (the lifo prototype's proven guard).
 */
export function watchProject(options: WatchOptions): ProjectWatcher {
  const { rootDir, vfsHas, onFlush } = options;
  const debounceMs = options.debounceMs ?? 200;

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let building = false;
  let rearm = false;

  const flush = async () => {
    timer = null;
    if (building) {
      rearm = true;
      return;
    }
    building = true;
    const batch = new Set(pending);
    pending.clear();
    try {
      await onFlush(diffPending(rootDir, batch, vfsHas));
    } finally {
      building = false;
      if (rearm || pending.size > 0) {
        rearm = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };

  const watcher: FSWatcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    // chokidar v4 dropped glob support -- ignores must be a function.
    ignored: (absPath: string) => {
      const vfsPath = diskToVfs(rootDir, absPath);
      if (vfsPath === null) return true;
      if (vfsPath === "/") return false;
      return shouldSkip(vfsPath);
    },
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });

  const onFsEvent = (absPath: string) => {
    const vfsPath = diskToVfs(rootDir, absPath);
    if (!vfsPath || shouldSkip(vfsPath)) return;
    pending.add(vfsPath);
    schedule();
  };

  watcher.on("add", onFsEvent);
  watcher.on("change", onFsEvent);
  watcher.on("unlink", onFsEvent);

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
