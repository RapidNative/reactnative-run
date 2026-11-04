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

  pullMissingImports(rootDir, changes, vfsHas);
  return { changes, needsReinit, assetChanges };
}

/** Local import, re-export and require specifiers in a source file. */
const IMPORT_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const SOURCE_RE = /\.(tsx|ts|jsx|js|mjs|cjs)$/;
const RESOLVE_SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".json", ".native.tsx", ".native.ts", ".ios.tsx", ".android.tsx"];
const INDEX_SUFFIXES = ["/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/** VFS paths a local specifier may resolve to (relative, or the `@/` / `~/` app-root alias). */
function candidatePaths(fromVfsPath: string, spec: string): string[] {
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.posix.join(path.posix.dirname(fromVfsPath), spec);
  else if (spec.startsWith("@/") || spec.startsWith("~/")) base = "/" + spec.slice(2);
  else return [];
  return [...RESOLVE_SUFFIXES.map((s) => base + s), ...INDEX_SUFFIXES.map((s) => base + s)];
}

/**
 * Files the batch's code imports that are on disk but missing from the VFS, added as creates.
 *
 * The watcher reports a file in a NEW folder late (chokidar first has to see the folder, watch it,
 * then report its files), and under gVisor sometimes not at all. A batch with the importer but
 * not the import then builds a throwing stub: the phone shows "Unable to resolve
 * "@/src/i18n/LanguageProvider" ... The file does not exist on the project filesystem." A Max
 * customer saw it for 30 minutes (2026-11-03) after the agent wrote a provider into a new
 * src/i18n/ folder. The disk is the truth; read the import from it now. Recursive: the pulled file's
 * own new imports come too.
 */
export function pullMissingImports(
  rootDir: string,
  changes: ContentChange[],
  vfsHas: (p: string) => boolean
): void {
  const inBatch = new Set(changes.filter((c) => c.type !== "delete").map((c) => c.path));
  const queue = changes.filter((c) => c.type !== "delete" && SOURCE_RE.test(c.path)) as Array<ContentChange & { content: string }>;
  while (queue.length) {
    const change = queue.shift()!;
    if (typeof change.content !== "string") continue;
    for (const m of change.content.matchAll(IMPORT_SPEC_RE)) {
      const candidates = candidatePaths(change.path, m[1]);
      if (!candidates.length || candidates.some((c) => inBatch.has(c) || vfsHas(c))) continue;
      for (const vfsPath of candidates) {
        if (shouldSkip(vfsPath) || isAssetPath(vfsPath)) continue;
        let content: string;
        try {
          const diskPath = path.join(rootDir, vfsPath.slice(1));
          if (!fs.statSync(diskPath).isFile()) continue;
          content = fs.readFileSync(diskPath, "utf8");
        } catch {
          continue;
        }
        const created = { path: vfsPath, type: "create", content } as ContentChange & { content: string };
        changes.push(created);
        inBatch.add(vfsPath);
        if (SOURCE_RE.test(vfsPath)) queue.push(created);
        break;
      }
    }
  }
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
