import { FileMap, FileChange } from "./types.js";

export class VirtualFS {
  private files: FileMap;

  constructor(files: FileMap) {
    this.files = { ...files };
  }

  read(path: string): string | undefined {
    const entry = this.files[path];
    if (entry === undefined) return undefined;
    return entry.content;
  }

  write(path: string, content: string): void {
    this.files[path] = { content, isExternal: false };
  }

  delete(path: string): boolean {
    if (path in this.files) {
      delete this.files[path];
      return true;
    }
    return false;
  }

  exists(path: string): boolean {
    return path in this.files;
  }

  /** Check if a file is an external asset (binary file served from public/) */
  isExternalAsset(path: string): boolean {
    const entry = this.files[path];
    return entry !== undefined && entry.isExternal === true;
  }

  list(): string[] {
    return Object.keys(this.files);
  }

  getEntryFile(): string | null {
    // Try common entry points
    const candidates = [
      "/index.js",
      "/index.ts",
      "/index.tsx",
      "/index.jsx",
      "/App.js",
      "/App.ts",
      "/App.tsx",
      "/App.jsx",
    ];
    for (const c of candidates) {
      if (this.exists(c)) return c;
    }

    // Check package.json "main" field for local entry
    const pkgJson = this.read("/package.json");
    if (pkgJson) {
      try {
        const pkg = JSON.parse(pkgJson);
        if (typeof pkg.main === "string" && (pkg.main.startsWith(".") || pkg.main.startsWith("/"))) {
          const base = pkg.main.replace(/^\.\//, "/").replace(/^([^/])/, "/$1");
          if (this.exists(base)) return base;
          for (const ext of [".js", ".ts", ".tsx", ".jsx"]) {
            if (this.exists(base + ext)) return base + ext;
          }
        }
      } catch {}
    }

    return null;
  }

  /** Read the "main" field from package.json, if present */
  getPackageMain(): string | null {
    const pkgJson = this.read("/package.json");
    if (!pkgJson) return null;
    try {
      const pkg = JSON.parse(pkgJson);
      return typeof pkg.main === "string" ? pkg.main : null;
    } catch {
      return null;
    }
  }

  toFileMap(): FileMap {
    return { ...this.files };
  }

  /** Compare current state against an incoming FileMap, return list of changes */
  diff(newFiles: FileMap): FileChange[] {
    const changes: FileChange[] = [];

    // Check for creates and updates
    for (const path in newFiles) {
      if (!(path in this.files)) {
        changes.push({ path, type: "create" });
      } else if (this.files[path].content !== newFiles[path].content) {
        changes.push({ path, type: "update" });
      }
    }

    // Check for deletes
    for (const path in this.files) {
      if (!(path in newFiles)) {
        changes.push({ path, type: "delete" });
      }
    }

    return changes;
  }

  /** Replace all files at once */
  replaceAll(files: FileMap): void {
    this.files = { ...files };
  }
}
