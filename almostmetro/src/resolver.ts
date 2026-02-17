import { VirtualFS } from "./fs.js";
import { ResolverConfig } from "./types.js";

export class Resolver {
  private fs: VirtualFS;
  private sourceExts: string[];

  constructor(fs: VirtualFS, config: ResolverConfig) {
    this.fs = fs;
    this.sourceExts = config.sourceExts;
  }

  /** Check if a require target is an npm package (not a relative/absolute path) */
  isNpmPackage(target: string): boolean {
    return target[0] !== "." && target[0] !== "/";
  }

  /** Resolve a relative require path against the current module's directory */
  resolvePath(from: string, to: string): string {
    if (this.isNpmPackage(to)) return to;

    // Get directory of 'from'
    const parts = from.split("/");
    parts.pop(); // remove filename
    const dir = parts.join("/") || "/";

    // Resolve relative path
    const segments = (dir + "/" + to).split("/").filter(Boolean);
    const resolved: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === "..") resolved.pop();
      else if (segments[i] !== ".") resolved.push(segments[i]);
    }
    return "/" + resolved.join("/");
  }

  /** Try to find the actual file path (with extension, or index file) */
  resolveFile(resolved: string): string | null {
    if (this.fs.exists(resolved)) return resolved;

    // Try each configured source extension
    for (const ext of this.sourceExts) {
      const withExt = resolved + "." + ext;
      if (this.fs.exists(withExt)) return withExt;
    }

    // Try index files
    for (const ext of this.sourceExts) {
      const indexPath = resolved + "/index." + ext;
      if (this.fs.exists(indexPath)) return indexPath;
    }

    return null;
  }
}
