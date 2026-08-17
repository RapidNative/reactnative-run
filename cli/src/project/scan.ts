import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FileMap } from "browser-metro";
import { isAssetPath, imageDimensions } from "./assets.js";

export type AssetMeta = Record<string, { width?: number; height?: number; hash: string }>;

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
  return { files, skippedLarge, assetMeta };
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
