import { VirtualFS } from "./fs.js";
import { Resolver } from "./resolver.js";
import type { RawSourceMap } from "./source-map.js";
import {
  buildCombinedSourceMap,
  countNewlines,
  inlineSourceMap,
  shiftSourceMapOrigLines,
} from "./source-map.js";
import { BundlerConfig, BundlerPlugin, ModuleMap } from "./types.js";
import { findRequires, rewriteRequires, buildBundlePreamble, parseExternalsFromBody, hashDeps, parseDepBundle } from "./utils.js";

export class Bundler {
  private fs: VirtualFS;
  private resolver: Resolver;
  private config: BundlerConfig;
  private plugins: BundlerPlugin[];
  private prefetchedPackages: Record<string, string> = {};

  constructor(fs: VirtualFS, config: BundlerConfig) {
    this.fs = fs;
    this.config = config;
    const paths = Bundler.readTsconfigPaths(fs);
    this.resolver = new Resolver(fs, { ...config.resolver, ...(paths && { paths }) });
    this.plugins = config.plugins ?? [];
  }

  /** Prefetch all dependencies in a single batch request */
  private async prefetchDependencies(): Promise<void> {
    const versions = this.getPackageVersions();
    if (Object.keys(versions).length === 0) return;

    // Remove aliased and shimmed packages - they're handled client-side
    const aliases = this.getModuleAliases();
    const shims = this.getShimModules();
    for (const name of Object.keys(aliases)) delete versions[name];
    for (const name of Object.keys(shims)) delete versions[name];
    // Also remove alias targets that are already in versions (e.g. react-native-web is fetched via alias)
    if (Object.keys(versions).length === 0) return;

    const hash = await hashDeps(versions);
    const baseUrl = this.config.server.packageServerUrl;

    try {
      // Try GET first (CDN cacheable)
      const getRes = await fetch(`${baseUrl}/bundle-deps/${hash}`);
      if (getRes.ok) {
        const { packages } = parseDepBundle(await getRes.text());
        this.prefetchedPackages = packages;
        return;
      }

      // POST to build
      const postRes = await fetch(`${baseUrl}/bundle-deps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, dependencies: versions }),
      });
      if (postRes.ok) {
        const { packages } = parseDepBundle(await postRes.text());
        this.prefetchedPackages = packages;
      }
    } catch (err) {
      // Silently fall back to individual fetches
      console.warn("[prefetch] Failed, falling back to individual fetches:", err);
    }
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

  /** Transform a single file using the configured transformer */
  transformFile(filename: string, src: string): string {
    return this.runTransform(filename, src).code;
  }

  /** Bundle starting from the entry file, returning executable code */
  async bundle(entryFile: string): Promise<string> {
    const { moduleMap, sourceMapMap } = await this.buildModuleMap(entryFile);
    return this.emitBundle(moduleMap, sourceMapMap, entryFile);
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

  /** Resolve an npm specifier to a versioned form using package.json versions.
   *  Priority: user's package.json > transitive dep versions from manifests > bare name */
  private resolveNpmSpecifier(
    specifier: string,
    versions: Record<string, string>,
    transitiveDepsVersions?: Record<string, string>
  ): string {
    // Extract base package name: "@scope/pkg/sub" -> "@scope/pkg", "lodash/fp" -> "lodash"
    let baseName: string;
    if (specifier.startsWith("@")) {
      const parts = specifier.split("/");
      baseName = parts[0] + "/" + parts[1];
    } else {
      baseName = specifier.split("/")[0];
    }

    const version = versions[baseName] || (transitiveDepsVersions && transitiveDepsVersions[baseName]);
    if (!version) return specifier;

    const subpath = specifier.slice(baseName.length); // e.g. "/client" or ""
    return baseName + "@" + version + subpath;
  }

  /** Fetch a pre-bundled npm package from the package server */
  private async fetchPackage(specifier: string): Promise<{ code: string; externals: Record<string, string> }> {
    // Check prefetched registry first (extract base package name from versioned specifier)
    // specifier is like "react@19.1.0" or "react-dom@19.1.0/client"
    let baseName = specifier;
    const atIdx = specifier.indexOf("@", specifier.startsWith("@") ? 1 : 0);
    if (atIdx > 0) {
      baseName = specifier.slice(0, atIdx);
      const afterVersion = specifier.indexOf("/", atIdx + 1);
      if (afterVersion > 0) {
        baseName = specifier.slice(0, atIdx) + specifier.slice(afterVersion);
      }
    }

    if (this.prefetchedPackages[baseName]) {
      return { code: this.prefetchedPackages[baseName], externals: {} };
    }

    // Fallback to individual fetch
    const url = this.config.server.packageServerUrl + "/pkg/" + specifier;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("Failed to fetch package '" + specifier + "' (HTTP " + res.status + ")" + (body ? ": " + body.slice(0, 200) : ""));
    }
    const code = await res.text();
    const externals = parseExternalsFromBody(code);
    return { code, externals };
  }

  /** Build the module map by walking the dependency graph */
  private async buildModuleMap(
    entryFile: string,
  ): Promise<{ moduleMap: ModuleMap; sourceMapMap: Record<string, RawSourceMap> }> {
    // Prefetch all deps in a single batch request
    await this.prefetchDependencies();

    const moduleMap: ModuleMap = {};
    const sourceMapMap: Record<string, RawSourceMap> = {};
    const visited: { [key: string]: boolean } = {};
    const npmPackages: { [key: string]: boolean } = {};
    const versions = this.getPackageVersions();
    const transitiveDepsVersions: Record<string, string> = {};

    const walk = async (filePath: string): Promise<void> => {
      if (visited[filePath]) return;
      visited[filePath] = true;

      // Asset files get a stub module that exports the filename (or a real URL for external assets)
      if (this.resolver.isAssetFile(filePath)) {
        if (this.fs.isExternalAsset(filePath) && this.config.assetPublicPath) {
          const assetUrl = this.config.assetPublicPath + filePath;
          moduleMap[filePath] = "module.exports = { uri: " + JSON.stringify(assetUrl) + " };";
        } else {
          moduleMap[filePath] = "module.exports = " + JSON.stringify(filePath) + ";";
        }
        return;
      }

      const source = this.fs.read(filePath);
      if (source === undefined) {
        throw new Error("File not found: " + filePath);
      }

      // Transform the file (TS -> JS, JSX -> JS, etc.)
      const { code: transformed, sourceMap } = this.runTransform(filePath, source);
      if (sourceMap) sourceMapMap[filePath] = sourceMap;

      const rewritten = rewriteRequires(transformed, filePath, this.makeResolveTarget(filePath));
      moduleMap[filePath] = rewritten;

      const deps = findRequires(rewritten);
      for (let i = 0; i < deps.length; i++) {
        const dep = deps[i];
        if (this.resolver.isNpmPackage(dep)) {
          if (!npmPackages[dep]) {
            npmPackages[dep] = true;
          }
        } else {
          const resolved = this.resolver.resolveFile(dep);
          if (resolved) {
            await walk(resolved);
          }
        }
      }
    };

    await walk(entryFile);

    // Remove externals from npm packages (they're provided by the host runtime)
    const externals = new Set(this.config.externals ?? []);
    for (const name of externals) {
      delete npmPackages[name];
    }
    // Also remove any package that starts with an external prefix (e.g. "react-native/..." if "react-native" is external)
    for (const name of Object.keys(npmPackages)) {
      for (const ext of externals) {
        if (name === ext || name.startsWith(ext + "/")) {
          delete npmPackages[name];
        }
      }
    }

    // Process module aliases: swap sources for targets in the fetch list
    const aliases = this.getModuleAliases();
    for (const [from, to] of Object.entries(aliases)) {
      delete npmPackages[from];
      if (!externals.has(to)) {
        npmPackages[to] = true;
      }
    }

    // Collect shims: these replace npm packages with inline code
    const shims = this.getShimModules();
    for (const name of Object.keys(shims)) {
      delete npmPackages[name];
    }

    // Fetch npm packages in parallel, then resolve any transitive deps (subpath requires etc.)
    const skipNames = new Set([...Object.keys(aliases), ...Object.keys(shims)]);
    const knownNpm = new Set(Object.keys(npmPackages));
    let toFetch = [...knownNpm];

    while (toFetch.length > 0) {
      const fetches = toFetch.map((name: string) => {
        const versionedSpecifier = this.resolveNpmSpecifier(name, versions, transitiveDepsVersions);
        return this.fetchPackage(versionedSpecifier).then(({ code, externals }) => {
          moduleMap[name] = code;
          // Merge externals into transitive versions (don't overwrite existing entries)
          for (const [dep, ver] of Object.entries(externals)) {
            if (!transitiveDepsVersions[dep]) {
              transitiveDepsVersions[dep] = ver;
            }
          }
        });
      });
      await Promise.all(fetches);

      // Discover any npm deps from fetched packages not yet known
      toFetch = [];
      for (const name of knownNpm) {
        for (const dep of findRequires(moduleMap[name])) {
          if (this.resolver.isNpmPackage(dep) && !knownNpm.has(dep) && !skipNames.has(dep)) {
            knownNpm.add(dep);
            toFetch.push(dep);
          }
        }
      }
    }

    // Inject alias shim modules: require("react-native") → re-exports react-native-web
    for (const [from, to] of Object.entries(aliases)) {
      moduleMap[from] = 'module.exports = require("' + to + '");';
    }

    // Inject inline shim modules
    for (const [name, code] of Object.entries(shims)) {
      moduleMap[name] = code;
    }

    return { moduleMap, sourceMapMap };
  }

  /** Emit the final bundle string */
  private emitBundle(
    moduleMap: ModuleMap,
    sourceMapMap: Record<string, RawSourceMap>,
    entryFile: string,
  ): string {
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
      JSON.stringify(entryFile) +
      ");\n" +
      "})({\n";

    const headerStr = preamble + runtimeStr;
    const ids = Object.keys(moduleMap);

    const moduleEntries = ids
      .map((id: string) => {
        return (
          JSON.stringify(id) +
          ": function(module, exports, require) {\n" +
          moduleMap[id] +
          "\n}"
        );
      })
      .join(",\n\n");

    let bundle = headerStr + moduleEntries + "\n});\n";

    // Build combined source map
    let lineOffset = countNewlines(headerStr);
    const inputs: {
      sourceFile: string;
      sourceContent: string;
      map: RawSourceMap;
      generatedLineOffset: number;
    }[] = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (i > 0) lineOffset += 2; // ",\n\n"
      lineOffset += 1; // wrapper function line

      if (sourceMapMap[id]) {
        const sourceContent = this.fs.read(id);
        if (sourceContent) {
          inputs.push({
            sourceFile: id,
            sourceContent,
            map: sourceMapMap[id],
            generatedLineOffset: lineOffset,
          });
        }
      }

      lineOffset += countNewlines(moduleMap[id]);
      lineOffset += 1; // "\n}"
    }

    if (inputs.length > 0) {
      bundle += inlineSourceMap(buildCombinedSourceMap(inputs)) + "\n";
    }

    return bundle;
  }

  /**
   * Emit a Metro-compatible native bundle using __d/__r module system.
   * This format is understood by Expo Go and React Native runtime.
   */
  private emitNativeBundle(
    moduleMap: ModuleMap,
    entryFile: string,
  ): string {
    const ids = Object.keys(moduleMap);

    // Assign numeric IDs (Metro uses numbers, not strings)
    const idMap: Record<string, number> = {};
    ids.forEach((id, i) => { idMap[id] = i; });

    // Metro preamble
    let bundle =
      "var __BUNDLE_START_TIME__=this.nativePerformanceNow?nativePerformanceNow():Date.now()," +
      "__DEV__=true,process={env:{NODE_ENV:\"development\"}},__METRO_GLOBAL_PREFIX__='';\n\n";

    // Metro module system
    bundle +=
      "(function (global) {\n" +
      "  'use strict';\n" +
      "  var modules = Object.create(null);\n" +
      "  function define(factory, moduleId, dependencyMap) {\n" +
      "    modules[moduleId] = {\n" +
      "      factory: factory, dependencyMap: dependencyMap || [],\n" +
      "      isInitialized: false, publicModule: { exports: {} }\n" +
      "    };\n" +
      "  }\n" +
      "  function metroRequire(moduleId) {\n" +
      "    if (typeof moduleId === 'string') {\n" +
      "      // String require - try global require (Expo Go's modules)\n" +
      "      try { return global.require ? global.require(moduleId) : require(moduleId); } catch(e) {}\n" +
      "    }\n" +
      "    var module = modules[moduleId];\n" +
      "    if (!module) throw new Error('Module not found: ' + moduleId);\n" +
      "    if (module.isInitialized) return module.publicModule.exports;\n" +
      "    module.isInitialized = true;\n" +
      "    var _require = function(id) {\n" +
      "      if (typeof id === 'number') return metroRequire(id);\n" +
      "      return metroRequire(id);\n" +
      "    };\n" +
      "    module.factory(global, _require, module, module.publicModule.exports, module.dependencyMap);\n" +
      "    return module.publicModule.exports;\n" +
      "  }\n" +
      "  global.__d = define;\n" +
      "  global.__r = metroRequire;\n" +
      "  global.__c = Object.create(null);\n" +
      "  global.__registerSegment = function() {};\n" +
      "})(typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : this);\n\n";

    // Emit each module as __d(factory, numericId, [depIds])
    for (const id of ids) {
      const numId = idMap[id];
      const code = moduleMap[id];

      // Rewrite require("name") calls to use numeric IDs where possible
      const rewrittenCode = code.replace(
        /require\((['"]((?:\.\/|\.\.\/|\/)[^'"]+)['"])\)/g,
        (_match: string, _full: string, dep: string) => {
          if (idMap[dep] !== undefined) {
            return `require(${idMap[dep]})`;
          }
          return _match;
        }
      );

      bundle += `__d(function(global, require, module, exports, _dependencyMap) {\n`;
      bundle += rewrittenCode + "\n";
      bundle += `}, ${numId}, []);\n\n`;
    }

    // Start the entry module
    bundle += `__r(${idMap[entryFile]});\n`;

    return bundle;
  }

  /**
   * Bundle for native (Metro __d/__r format for Expo Go).
   * Same as bundle() but outputs Metro-compatible format.
   */
  async bundleNative(entryFile: string): Promise<string> {
    const { moduleMap } = await this.buildModuleMap(entryFile);
    return this.emitNativeBundle(moduleMap, entryFile);
  }
}
