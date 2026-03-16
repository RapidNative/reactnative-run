import { VirtualFS } from "./fs.js";
import { Resolver } from "./resolver.js";
import { DependencyGraph } from "./dependency-graph.js";
import { ModuleCache } from "./module-cache.js";
import { emitHmrBundle, HMR_RUNTIME_TEMPLATE } from "./hmr-runtime.js";
import type { RawSourceMap } from "./source-map.js";
import {
  buildCombinedSourceMap,
  countNewlines,
  inlineSourceMap,
  shiftSourceMapOrigLines,
} from "./source-map.js";
import { findRequires, rewriteRequires, hashString, buildBundlePreamble } from "./utils.js";
import type {
  BundlerConfig,
  BundlerPlugin,
  ModuleMap,
  FileChange,
  HmrUpdate,
  IncrementalBuildResult,
} from "./types.js";

export class IncrementalBundler {
  private fs: VirtualFS;
  private resolver: Resolver;
  private config: BundlerConfig;
  private plugins: BundlerPlugin[];
  readonly graph: DependencyGraph = new DependencyGraph();
  readonly cache: ModuleCache = new ModuleCache();
  private moduleMap: ModuleMap = {};
  private sourceMapMap: Record<string, RawSourceMap> = {};
  private entryFile: string | null = null;
  private packageVersions: Record<string, string> = {};
  private transitiveDepsVersions: Record<string, string> = {};

  constructor(fs: VirtualFS, config: BundlerConfig) {
    this.fs = fs;
    this.config = config;
    const paths = IncrementalBundler.readTsconfigPaths(fs);
    this.resolver = new Resolver(fs, { ...config.resolver, ...(paths && { paths }) });
    this.plugins = config.plugins ?? [];
  }

  /** Read tsconfig.json "compilerOptions.paths" from the VirtualFS */
  private static readTsconfigPaths(fs: VirtualFS): Record<string, string[]> | null {
    const raw = fs.read("/tsconfig.json");
    if (!raw) return null;
    try {
      const tsconfig = JSON.parse(raw);
      const paths = tsconfig?.compilerOptions?.paths;
      return paths && typeof paths === "object" ? paths : null;
    } catch {
      return null;
    }
  }

  /** Run the full pre-transform -> Sucrase -> post-transform pipeline */
  private runTransform(
    filename: string,
    src: string,
  ): { code: string; sourceMap?: RawSourceMap } {
    const originalLines = countNewlines(src);

    // Pre-transform hooks
    for (const plugin of this.plugins) {
      if (plugin.transformSource) {
        const result = plugin.transformSource({ src, filename });
        if (result) src = result.src;
      }
    }

    const preTransformAddedLines = countNewlines(src) - originalLines;

    // Core transform (Sucrase)
    const transformResult = this.config.transformer.transform({ src, filename });
    let code = transformResult.code;
    let sourceMap = transformResult.sourceMap;

    // Post-transform hooks -- track line additions for source map offset
    const linesBeforePost = countNewlines(code);
    for (const plugin of this.plugins) {
      if (plugin.transformOutput) {
        const result = plugin.transformOutput({ code, filename });
        if (result) code = result.code;
      }
    }

    // Adjust source map for plugin modifications
    if (sourceMap) {
      // Post-transform: shift generated lines for prepended output lines
      const postAddedLines = countNewlines(code) - linesBeforePost;
      if (postAddedLines > 0) {
        sourceMap = {
          ...sourceMap,
          mappings: ";".repeat(postAddedLines) + sourceMap.mappings,
        };
      }
      // Pre-transform: shift origLine back so mappings point to original source
      if (preTransformAddedLines > 0) {
        sourceMap = shiftSourceMapOrigLines(sourceMap, -preTransformAddedLines);
      }
    }

    return { code, sourceMap };
  }

  /** Build a resolve callback that consults plugins then falls back to default resolution */
  private makeResolveTarget(fromFile: string): (target: string) => string | null {
    return (target: string): string | null => {
      // Let plugins resolve first
      for (const plugin of this.plugins) {
        if (plugin.resolveRequest) {
          const result = plugin.resolveRequest({ fromFile }, target);
          if (result !== null) return result;
        }
      }

      // Default resolution: skip npm packages, resolve local paths
      if (this.resolver.isNpmPackage(target)) return null;
      const resolved = this.resolver.resolvePath(fromFile, target);
      const actual = this.resolver.resolveFile(resolved);
      return actual ?? null;
    };
  }

  /** Collect module aliases from all plugins */
  private getModuleAliases(): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const plugin of this.plugins) {
      if (plugin.moduleAliases) {
        Object.assign(aliases, plugin.moduleAliases());
      }
    }
    return aliases;
  }

  /** Collect module shims from all plugins */
  private getShimModules(): Record<string, string> {
    const shims: Record<string, string> = {};
    for (const plugin of this.plugins) {
      if (plugin.shimModules) {
        Object.assign(shims, plugin.shimModules());
      }
    }
    return shims;
  }

  /** Scan npm packages in the module map for require calls not yet fetched */
  private findTransitiveNpmDeps(skipNames: Set<string>): Set<string> {
    const newDeps = new Set<string>();
    for (const [name, code] of Object.entries(this.moduleMap)) {
      if (!this.resolver.isNpmPackage(name)) continue;
      for (const dep of findRequires(code)) {
        if (this.resolver.isNpmPackage(dep) && !(dep in this.moduleMap) && !skipNames.has(dep)) {
          newDeps.add(dep);
        }
      }
    }
    return newDeps;
  }

  /** Transform a single file using the configured transformer */
  private transformFile(filename: string, src: string): string {
    return this.runTransform(filename, src).code;
  }

  /** Read dependency versions from the project's package.json */
  private getPackageVersions(): Record<string, string> {
    const raw = this.fs.read("/package.json");
    if (!raw) return {};
    try {
      const pkg = JSON.parse(raw);
      return pkg.dependencies || {};
    } catch {
      return {};
    }
  }

  /** Resolve an npm specifier to a versioned form.
   *  Priority: user's package.json > transitive dep versions from manifests > bare name */
  private resolveNpmSpecifier(
    specifier: string,
    versions: Record<string, string>,
  ): string {
    let baseName: string;
    if (specifier.startsWith("@")) {
      const parts = specifier.split("/");
      baseName = parts[0] + "/" + parts[1];
    } else {
      baseName = specifier.split("/")[0];
    }
    const version = versions[baseName] || this.transitiveDepsVersions[baseName];
    if (!version) return specifier;
    const subpath = specifier.slice(baseName.length);
    return baseName + "@" + version + subpath;
  }

  /** Fetch a pre-bundled npm package from the package server */
  private async fetchPackage(specifier: string): Promise<{ code: string; externals: Record<string, string> }> {
    const url = this.config.server.packageServerUrl + "/pkg/" + specifier;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("Failed to fetch package '" + specifier + "' (HTTP " + res.status + ")" + (body ? ": " + body.slice(0, 200) : ""));
    }
    const code = await res.text();
    let externals: Record<string, string> = {};
    const externalsHeader = res.headers.get("X-Externals");
    if (externalsHeader) {
      try { externals = JSON.parse(externalsHeader); } catch {}
    }
    return { code, externals };
  }

  /**
   * Process a single local file: transform, rewrite requires, extract deps,
   * update cache and graph. Returns the list of npm deps found.
   */
  private processFile(filePath: string): {
    localDeps: string[];
    npmDeps: string[];
  } {
    // Asset files get a stub module that exports the filename (or a real URL for external assets)
    if (this.resolver.isAssetFile(filePath)) {
      if (this.fs.isExternalAsset(filePath) && this.config.assetPublicPath) {
        const assetUrl = this.config.assetPublicPath + filePath;
        this.moduleMap[filePath] = "module.exports = { uri: " + JSON.stringify(assetUrl) + " };";
      } else {
        this.moduleMap[filePath] = "module.exports = " + JSON.stringify(filePath) + ";";
      }
      return { localDeps: [], npmDeps: [] };
    }

    const source = this.fs.read(filePath);
    if (!source) {
      throw new Error("File not found: " + filePath);
    }

    const sourceHash = hashString(source);

    // Check cache validity
    if (this.cache.isValid(filePath, sourceHash)) {
      const cached = this.cache.getModule(filePath)!;
      this.moduleMap[filePath] = cached.rewrittenCode;
      if (cached.sourceMap) this.sourceMapMap[filePath] = cached.sourceMap;
      return {
        localDeps: cached.resolvedLocalDeps,
        npmDeps: cached.npmDeps,
      };
    }

    // Transform
    const { code: transformed, sourceMap } = this.runTransform(filePath, source);
    if (sourceMap) this.sourceMapMap[filePath] = sourceMap;

    // Rewrite requires
    const rewritten = rewriteRequires(transformed, filePath, this.makeResolveTarget(filePath));

    // Extract deps from rewritten code (has absolute paths for local deps)
    const rawDeps = findRequires(transformed);
    const allDeps = findRequires(rewritten);

    const localDeps: string[] = [];
    const npmDeps: string[] = [];

    for (const dep of allDeps) {
      if (this.resolver.isNpmPackage(dep)) {
        npmDeps.push(dep);
      } else {
        localDeps.push(dep);
      }
    }

    // Update cache
    this.cache.setModule(filePath, {
      sourceHash,
      transformedCode: transformed,
      rewrittenCode: rewritten,
      rawDeps,
      resolvedLocalDeps: localDeps,
      npmDeps,
      sourceMap,
    });

    // Update graph
    this.graph.setModule(filePath, localDeps, npmDeps);

    // Update module map
    this.moduleMap[filePath] = rewritten;

    return { localDeps, npmDeps };
  }

  /** Walk the dependency tree starting from a file, processing all reachable modules */
  private walkDeps(
    startFile: string,
    npmPackagesNeeded: Set<string>,
  ): void {
    const visited = new Set<string>();
    const queue = [startFile];

    while (queue.length > 0) {
      const filePath = queue.shift()!;
      if (visited.has(filePath)) continue;
      visited.add(filePath);

      const { localDeps, npmDeps } = this.processFile(filePath);

      for (const dep of npmDeps) {
        npmPackagesNeeded.add(dep);
      }

      for (const dep of localDeps) {
        if (!visited.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  /** Fetch all npm packages that aren't already cached */
  private async fetchNpmPackages(
    npmPackagesNeeded: Set<string>,
  ): Promise<void> {
    const versions = this.packageVersions;
    const toFetch: { name: string; specifier: string }[] = [];

    for (const name of npmPackagesNeeded) {
      const specifier = this.resolveNpmSpecifier(name, versions);
      if (!this.cache.hasNpmPackage(specifier)) {
        toFetch.push({ name, specifier });
      } else {
        // Use cached version
        this.moduleMap[name] = this.cache.getNpmPackage(specifier)!;
      }
    }

    if (toFetch.length > 0) {
      const results = await Promise.all(
        toFetch.map(({ specifier }) => this.fetchPackage(specifier)),
      );
      for (let i = 0; i < toFetch.length; i++) {
        const { name, specifier } = toFetch[i];
        const { code, externals } = results[i];
        this.cache.setNpmPackage(specifier, code);
        this.moduleMap[name] = code;
        // Merge externals into transitive versions (don't overwrite existing entries)
        for (const [dep, ver] of Object.entries(externals)) {
          if (!this.transitiveDepsVersions[dep]) {
            this.transitiveDepsVersions[dep] = ver;
          }
        }
      }
    }
  }

  /** Emit the bundle using HMR runtime or standard IIFE */
  private emitBundle(): string {
    const hmrEnabled = this.config.hmr?.enabled ?? false;
    const reactRefresh = this.config.hmr?.reactRefresh ?? false;

    let bundle: string;
    let headerStr: string;

    if (hmrEnabled) {
      bundle = emitHmrBundle(
        this.moduleMap,
        this.entryFile!,
        this.graph.getReverseDepsMap(),
        reactRefresh,
        this.config.env,
        this.config.routerShim,
      );
      headerStr =
        buildBundlePreamble(this.config.env, this.config.routerShim) +
        HMR_RUNTIME_TEMPLATE +
        "({\n";
    } else {
      // Fallback to standard IIFE (same as Bundler.emitBundle)
      const preamble = buildBundlePreamble(this.config.env, this.config.routerShim);
      const runtimeStr =
        "(function(modules) {\n" +
        "  var cache = {};\n" +
        "  function require(id) {\n" +
        "    if (cache[id]) return cache[id].exports;\n" +
        "    if (!modules[id]) throw new Error('Module not found: ' + id);\n" +
        "    var module = cache[id] = { exports: {} };\n" +
        "    modules[id].call(module.exports, module, module.exports, require);\n" +
        "    return module.exports;\n" +
        "  }\n" +
        "  require(" +
        JSON.stringify(this.entryFile) +
        ");\n" +
        "})({\n";

      headerStr = preamble + runtimeStr;

      const moduleEntries = Object.keys(this.moduleMap)
        .map((id) => {
          return (
            JSON.stringify(id) +
            ": function(module, exports, require) {\n" +
            this.moduleMap[id] +
            "\n}"
          );
        })
        .join(",\n\n");

      bundle = headerStr + moduleEntries + "\n});\n";
    }

    // Build and append combined source map
    const inputs = this.buildSourceMapInputs(countNewlines(headerStr));
    if (inputs.length > 0) {
      bundle += inlineSourceMap(buildCombinedSourceMap(inputs)) + "\n";
    }

    return bundle;
  }

  /** Compute source map inputs with correct line offsets for each module */
  private buildSourceMapInputs(headerLineCount: number): {
    sourceFile: string;
    sourceContent: string;
    map: RawSourceMap;
    generatedLineOffset: number;
  }[] {
    let lineOffset = headerLineCount;
    const inputs: {
      sourceFile: string;
      sourceContent: string;
      map: RawSourceMap;
      generatedLineOffset: number;
    }[] = [];
    const ids = Object.keys(this.moduleMap);

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (i > 0) lineOffset += 2; // ",\n\n"
      lineOffset += 1; // wrapper function line

      if (this.sourceMapMap[id]) {
        const sourceContent = this.fs.read(id);
        if (sourceContent) {
          inputs.push({
            sourceFile: id,
            sourceContent,
            map: this.sourceMapMap[id],
            generatedLineOffset: lineOffset,
          });
        }
      }

      lineOffset += countNewlines(this.moduleMap[id]);
      lineOffset += 1; // "\n}"
    }

    return inputs;
  }

  /** Initial full build */
  async build(entryFile: string): Promise<IncrementalBuildResult> {
    const startTime = performance.now();

    this.entryFile = entryFile;
    this.moduleMap = {};
    this.sourceMapMap = {};
    this.packageVersions = this.getPackageVersions();

    const npmPackagesNeeded = new Set<string>();

    this.walkDeps(entryFile, npmPackagesNeeded);

    // Process module aliases: swap sources for targets in the fetch list
    const aliases = this.getModuleAliases();
    for (const [from, to] of Object.entries(aliases)) {
      npmPackagesNeeded.delete(from);
      npmPackagesNeeded.add(to);
    }

    // Collect shims: these replace npm packages with inline code
    const shims = this.getShimModules();
    for (const name of Object.keys(shims)) {
      npmPackagesNeeded.delete(name);
    }

    // React Refresh runtime must be in the module map for the HMR runtime to require() it
    if (this.config.hmr?.reactRefresh) {
      npmPackagesNeeded.add("react-refresh/runtime");
    }

    await this.fetchNpmPackages(npmPackagesNeeded);

    // Resolve transitive npm deps (subpath requires like react-dom/client)
    const skipNames = new Set([...Object.keys(aliases), ...Object.keys(shims)]);
    let newDeps = this.findTransitiveNpmDeps(skipNames);
    while (newDeps.size > 0) {
      await this.fetchNpmPackages(newDeps);
      newDeps = this.findTransitiveNpmDeps(skipNames);
    }

    // Inject alias shim modules
    for (const [from, to] of Object.entries(aliases)) {
      this.moduleMap[from] = 'module.exports = require("' + to + '");';
    }

    // Inject inline shim modules
    for (const [name, code] of Object.entries(shims)) {
      this.moduleMap[name] = code;
    }

    const bundle = this.emitBundle();
    const buildTime = performance.now() - startTime;

    return {
      bundle,
      hmrUpdate: null,
      type: "full",
      rebuiltModules: Object.keys(this.moduleMap).filter(
        (id) => !this.resolver.isNpmPackage(id),
      ),
      removedModules: [],
      buildTime,
    };
  }

  /** Incremental rebuild based on file changes */
  async rebuild(changes: FileChange[]): Promise<IncrementalBuildResult> {
    const startTime = performance.now();

    if (!this.entryFile) {
      throw new Error("Must call build() before rebuild()");
    }

    // Check if we need a full rebuild
    const packageJsonChange = changes.find((c) => c.path === "/package.json");
    if (packageJsonChange && packageJsonChange.type !== "delete") {
      const newVersions = this.getPackageVersions();
      const oldVersions = this.packageVersions;
      const depsChanged =
        JSON.stringify(newVersions) !== JSON.stringify(oldVersions);
      if (depsChanged) {
        // Full rebuild: invalidate all npm caches and transitive version map
        this.cache.invalidateNpmPackages();
        this.transitiveDepsVersions = {};
        this.packageVersions = newVersions;
        return this.build(this.entryFile);
      }
    }

    // Check if entry file was deleted
    const entryDeleted = changes.some(
      (c) => c.path === this.entryFile && c.type === "delete",
    );
    if (entryDeleted) {
      return this.build(this.entryFile);
    }

    // Incremental rebuild
    const rebuiltModules: string[] = [];
    const removedModules: string[] = [];
    const filesToReprocess = new Set<string>();
    const npmPackagesNeeded = new Set<string>();

    // Collect all npm packages already in the module map
    for (const id of Object.keys(this.moduleMap)) {
      if (this.resolver.isNpmPackage(id)) {
        npmPackagesNeeded.add(id);
      }
    }

    // Phase 1: Classify changes and collect files to reprocess
    for (const change of changes) {
      if (change.path === "/package.json") continue;

      if (change.type === "delete") {
        // Remove from graph, cache, and module map
        const dependents = this.graph.getDependents(change.path);
        this.graph.removeModule(change.path);
        this.cache.invalidateModule(change.path);
        delete this.moduleMap[change.path];
        delete this.sourceMapMap[change.path];
        removedModules.push(change.path);

        // Dependents need reprocessing (their require target is gone)
        for (const dep of dependents) {
          filesToReprocess.add(dep);
        }
      } else {
        // Create or update: only reprocess the changed file itself.
        // Dependents don't need re-transformation -- the HMR runtime
        // handles re-execution by walking accept boundaries.
        this.cache.invalidateModule(change.path);
        filesToReprocess.add(change.path);
      }
    }

    // Phase 2: Reprocess each affected file
    for (const filePath of filesToReprocess) {
      if (!this.fs.exists(filePath)) continue;

      const { localDeps, npmDeps } = this.processFile(filePath);
      rebuiltModules.push(filePath);

      for (const dep of npmDeps) {
        npmPackagesNeeded.add(dep);
      }

      // Walk any new local deps that aren't yet in the graph
      for (const dep of localDeps) {
        if (!this.graph.hasModule(dep) && this.fs.exists(dep)) {
          this.walkDeps(dep, npmPackagesNeeded);
          rebuiltModules.push(dep);
        }
      }
    }

    // Process module aliases for incremental rebuilds
    const aliases = this.getModuleAliases();
    for (const [from, to] of Object.entries(aliases)) {
      npmPackagesNeeded.delete(from);
      npmPackagesNeeded.add(to);
    }

    // Collect shims
    const shims = this.getShimModules();
    for (const name of Object.keys(shims)) {
      npmPackagesNeeded.delete(name);
    }

    // Ensure react-refresh/runtime stays in the module map
    if (this.config.hmr?.reactRefresh) {
      npmPackagesNeeded.add("react-refresh/runtime");
    }

    // Phase 3: Fetch any new npm packages + transitive deps
    await this.fetchNpmPackages(npmPackagesNeeded);
    const skipNames = new Set([...Object.keys(aliases), ...Object.keys(shims)]);
    let newDeps = this.findTransitiveNpmDeps(skipNames);
    while (newDeps.size > 0) {
      await this.fetchNpmPackages(newDeps);
      newDeps = this.findTransitiveNpmDeps(skipNames);
    }

    // Inject alias shim modules
    for (const [from, to] of Object.entries(aliases)) {
      this.moduleMap[from] = 'module.exports = require("' + to + '");';
    }

    // Inject inline shim modules
    for (const [name, code] of Object.entries(shims)) {
      this.moduleMap[name] = code;
    }

    // Phase 4: Orphan cleanup
    const orphans = this.graph.findOrphans(this.entryFile);
    for (const orphan of orphans) {
      this.graph.removeModule(orphan);
      this.cache.invalidateModule(orphan);
      delete this.moduleMap[orphan];
      delete this.sourceMapMap[orphan];
      removedModules.push(orphan);
    }

    // Phase 5: Emit result
    const bundle = this.emitBundle();
    const buildTime = performance.now() - startTime;

    // Build HMR update
    let hmrUpdate: HmrUpdate | null = null;
    const hmrEnabled = this.config.hmr?.enabled ?? false;

    if (hmrEnabled && rebuiltModules.length > 0) {
      const entryChanged = rebuiltModules.includes(this.entryFile);
      if (entryChanged) {
        hmrUpdate = {
          updatedModules: {},
          removedModules,
          requiresReload: true,
          reloadReason: "Entry file changed",
        };
      } else {
        const updatedModules: Record<string, string> = {};
        // new Function('module','exports','require', code) wraps with:
        //   function anonymous(module,exports,require\n) {\n<code>\n}
        // That's 2 extra lines before code starts
        const NEW_FUNCTION_LINES = 2;
        for (const id of rebuiltModules) {
          if (this.moduleMap[id] !== undefined) {
            let code = this.moduleMap[id];
            // Append per-module inline source map for HMR
            const sm = this.sourceMapMap[id];
            if (sm) {
              const sourceContent = this.fs.read(id);
              if (sourceContent) {
                code +=
                  "\n" +
                  inlineSourceMap({
                    version: 3,
                    sources: [id],
                    sourcesContent: [sourceContent],
                    names: sm.names || [],
                    mappings: ";".repeat(NEW_FUNCTION_LINES) + sm.mappings,
                  });
              }
            }
            code += "\n//# sourceURL=" + id;
            updatedModules[id] = code;
          }
        }
        hmrUpdate = {
          updatedModules,
          removedModules,
          requiresReload: false,
          reverseDepsMap: this.graph.getReverseDepsMap(),
        };
      }
    }

    return {
      bundle,
      hmrUpdate,
      type: "incremental",
      rebuiltModules,
      removedModules,
      buildTime,
    };
  }

  /** Update the virtual filesystem */
  updateFS(fs: VirtualFS): void {
    this.fs = fs;
    const paths = IncrementalBundler.readTsconfigPaths(fs);
    this.resolver = new Resolver(fs, { ...this.config.resolver, ...(paths && { paths }) });
  }
}
