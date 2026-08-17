import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FileMap } from "browser-metro";
import { isAssetPath, imageDimensions } from "./assets.js";

export type AssetMeta = Record<
  string,
  {
    width?: number;
    height?: number;
    hash: string;
    /** Scale variants (e.g. [1, 2, 3] when foo.png/foo@2x.png/foo@3x.png exist). */
    scales?: number[];
    /** Content hash per scale, aligned with `scales`. */
    fileHashes?: string[];
  }
>;

/** `icon@2x.png` -> { base: "icon.png", scale: 2 } */
const SCALE_SUFFIX_RE = /^(.*)@(\d+(?:\.\d+)?)x(\.[a-z0-9]+)$/i;

/** Directory names never scanned or watched, anywhere in the tree. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".expo",
  ".expo-shared",
  "dist",
  "build",
  ".cache",
  ".next",
  ".tamagui",
  "coverage",
  // Native project folders: nothing in them resolves through browser-metro
  // (npm deps come pre-bundled from the package server) and they can be huge.
  "android",
  "ios",
]);

const SKIP_FILES = new Set([".DS_Store"]);

/** Text files above this size are skipped with a warning rather than fed to
 *  the transformer -- a pathological generated file shouldn't OOM a rebuild. */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export function shouldSkip(relPath: string): boolean {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1];
  if (SKIP_FILES.has(base)) return true;
  return segments.some((s) => SKIP_DIRS.has(s));
}

export interface ScanResult {
  files: FileMap;
  skippedLarge: string[];
  /** Dimensions + content hash per asset (native AssetRegistry needs them).
   *  Bytes are read once for the sniff/hash, then discarded. */
  assetMeta: AssetMeta;
}

/**
 * Walk a project directory into a browser-metro FileMap. Paths are
 * VFS-absolute POSIX ("/app/index.tsx"). Assets are marked isExternal with
 * empty content -- their bytes are streamed from disk on request, never held
 * in memory.
 */
export function scanProject(rootDir: string): ScanResult {
  const root = path.resolve(rootDir);
  const files: FileMap = {};
  const skippedLarge: string[] = [];
  const assetMeta: AssetMeta = {};

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = "/" + path.relative(root, abs).split(path.sep).join("/");
      if (shouldSkip(rel)) continue;
      // No symlink following: avoids cycles and out-of-project reads.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      if (isAssetPath(rel)) {
        files[rel] = { content: "", isExternal: true };
        try {
          const buf = fs.readFileSync(abs);
          const dims = imageDimensions(buf);
          assetMeta[rel] = {
            hash: createHash("md5").update(buf).digest("hex"),
            ...(dims ?? {}),
          };
        } catch {
          // Unreadable asset; registered without metadata.
        }
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_TEXT_FILE_BYTES) {
          skippedLarge.push(rel);
          continue;
        }
        files[rel] = { content: fs.readFileSync(abs, "utf8"), isExternal: false };
      } catch {
        // File vanished mid-scan; skip.
      }
    }
  };

  walk(root);
  groupScaleVariants(files, assetMeta);
  return { files, skippedLarge, assetMeta };
}

/**
 * Metro-style scale grouping: foo.png / foo@2x.png / foo@3x.png are ONE asset.
 * Code requires the base name; the descriptor advertises the available scales
 * and RN requests the best one back from /assets with the @Nx suffix (which
 * maps straight to the on-disk file). The base VFS entry is created even when
 * only scaled files exist, so `require("./foo.png")` always resolves.
 * Dimensions are in density-independent units: pixel size / scale.
 */
export function groupScaleVariants(files: FileMap, assetMeta: AssetMeta): void {
  const groups = new Map<string, { scale: number; path: string }[]>();
  for (const p of Object.keys(assetMeta)) {
    const m = p.match(SCALE_SUFFIX_RE);
    if (!m) continue;
    const base = m[1] + m[3];
    const list = groups.get(base) ?? [];
    list.push({ scale: parseFloat(m[2]), path: p });
    groups.set(base, list);
  }

  for (const [base, variants] of groups) {
    if (assetMeta[base]) variants.push({ scale: 1, path: base });
    variants.sort((a, b) => a.scale - b.scale);

    if (!files[base]) files[base] = { content: "", isExternal: true };
    const primary = variants[0];
    const primaryMeta = assetMeta[primary.path];
    if (!primaryMeta) continue;
    assetMeta[base] = {
      hash: primaryMeta.hash,
      scales: variants.map((v) => v.scale),
      fileHashes: variants.map((v) => assetMeta[v.path]?.hash ?? primaryMeta.hash),
      ...(primaryMeta.width !== undefined
        ? { width: Math.round(primaryMeta.width / primary.scale) }
        : {}),
      ...(primaryMeta.height !== undefined
        ? { height: Math.round(primaryMeta.height / primary.scale) }
        : {}),
    };
  }
}

/** Convert a VFS path back to the on-disk absolute path. */
export function vfsToDisk(rootDir: string, vfsPath: string): string {
  const rel = vfsPath.replace(/^\//, "");
  const abs = path.resolve(rootDir, rel);
  // Path-traversal guard: the resolved path must stay inside the project.
  const root = path.resolve(rootDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project root: ${vfsPath}`);
  }
  return abs;
}

/** Convert an on-disk absolute path to a VFS path, or null if outside root. */
export function diskToVfs(rootDir: string, absPath: string): string | null {
  const root = path.resolve(rootDir);
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return "/" + rel.split(path.sep).join("/");
}
