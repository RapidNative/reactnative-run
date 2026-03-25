import type { RawSourceMap } from "./source-map.js";

export interface CachedModule {
  sourceHash: string;
  transformedCode: string;
  rewrittenCode: string;
  rawDeps: string[];
  resolvedLocalDeps: string[];
  npmDeps: string[];
  sourceMap?: RawSourceMap;
}

export class ModuleCache {
  private modules: Map<string, CachedModule> = new Map();
  private npmPackages: Map<string, string> = new Map();

  getModule(id: string): CachedModule | undefined {
    return this.modules.get(id);
  }

  setModule(id: string, data: CachedModule): void {
    this.modules.set(id, data);
  }

  invalidateModule(id: string): void {
    this.modules.delete(id);
  }

  isValid(id: string, currentSourceHash: string): boolean {
    const cached = this.modules.get(id);
    return cached !== undefined && cached.sourceHash === currentSourceHash;
  }

  getNpmPackage(specifier: string): string | undefined {
    return this.npmPackages.get(specifier);
  }

  setNpmPackage(specifier: string, code: string): void {
    this.npmPackages.set(specifier, code);
  }

  hasNpmPackage(specifier: string): boolean {
    return this.npmPackages.has(specifier);
  }

  invalidateNpmPackages(): void {
    this.npmPackages.clear();
  }
}
