import { VirtualFS } from "./fs.js";
import { ResolverConfig } from "./types.js";

export class Resolver {
  private fs: VirtualFS;
  private sourceExts: string[];
  // Compiled path aliases: [prefix to match, prefix to replace with]
  private pathAliases: [string, string][] = [];

  constructor(fs: VirtualFS, config: ResolverConfig) {
    this.fs = fs;
    this.sourceExts = config.sourceExts;

    // Compile tsconfig "paths" into simple prefix pairs
    if (config.paths) {
      for (const [pattern, targets] of Object.entries(config.paths)) {
        if (!targets.length) continue;
        // "@/*" → prefix "@/", "./*" → replacement "/"
        const from = pattern.replace(/\*$/, "");
        const to = "/" + targets[0].replace(/^\.\/?/, "").replace(/\*$/, "");
        this.pathAliases.push([from, to]);
      }
    }
  }

  /** Expand tsconfig path aliases. Returns null if no alias matched. */
  private expandAlias(target: string): string | null {
    for (const [from, to] of this.pathAliases) {
      if (target.startsWith(from)) {
        return to + target.slice(from.length);
      }
    }
    return null;
  }

  /** Check if a require target is an npm package (not a relative/absolute path) */
  isNpmPackage(target: string): boolean {
    if (target[0] === "." || target[0] === "/") return false;
    if (this.expandAlias(target) !== null) return false;
    return true;
  }

  /** Resolve a relative require path against the current module's directory */
  resolvePath(from: string, to: string): string {
    // Expand path aliases first (e.g. "@/hooks/foo" → "/hooks/foo")
    const expanded = this.expandAlias(to);
    if (expanded) return expanded;

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

  /** Check if a path is an asset file (image, font, css, etc.) */
  isAssetFile(filePath: string): boolean {
    return /\.(png|jpe?g|gif|svg|webp|bmp|ico|ttf|otf|woff2?|mp[34]|wav|aac|pdf|css)$/i.test(filePath);
  }

  /** Try to find the actual file path (with extension, or index file) */
  resolveFile(resolved: string): string | null {
    if (this.fs.exists(resolved)) return resolved;

    // Asset files resolve to themselves even if not in VFS
    if (this.isAssetFile(resolved)) return resolved;

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
