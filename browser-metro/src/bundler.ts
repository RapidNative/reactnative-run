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
import { findRequires, rewriteRequires, buildBundlePreamble } from "./utils.js";

export class Bundler {
  private fs: VirtualFS;
  private resolver: Resolver;
  private config: BundlerConfig;
  private plugins: BundlerPlugin[];

  constructor(fs: VirtualFS, config: BundlerConfig) {
    this.fs = fs;
    this.config = config;
    const paths = Bundler.readTsconfigPaths(fs);
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

  /** Build the module map by walking the dependency graph */
  private async buildModuleMap(
    entryFile: string,
  ): Promise<{ moduleMap: ModuleMap; sourceMapMap: Record<string, RawSourceMap> }> {
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
      if (!source) {
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

    // Process module aliases: swap sources for targets in the fetch list
    const aliases = this.getModuleAliases();
    for (const [from, to] of Object.entries(aliases)) {
      delete npmPackages[from];
      npmPackages[to] = true;
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
}
