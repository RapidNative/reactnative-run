import { FileMap, FileChange } from "./types.js";

export class VirtualFS {
  private files: FileMap;

  constructor(files: FileMap) {
    this.files = { ...files };
  }

  read(path: string): string | undefined {
    return this.files[path];
  }

  write(path: string, content: string): void {
    this.files[path] = content;
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

  list(): string[] {
    return Object.keys(this.files);
  }

  getEntryFile(): string | null {
    // Try common entry points
    const candidates = ["/index.js", "/index.ts", "/index.tsx", "/index.jsx"];
    for (const c of candidates) {
      if (this.exists(c)) return c;
    }
    return null;
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
      } else if (this.files[path] !== newFiles[path]) {
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
