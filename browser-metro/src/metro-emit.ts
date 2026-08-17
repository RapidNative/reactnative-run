/**
 * Metro-compatible bundle emission for native (Expo Go / Hermes) targets.
 *
 * MILESTONE A (current): the entire existing string-keyed CJS registry bundle
 * is wrapped in ONE `__d(factory, 0, [])` plus a minimal Metro module system
 * and `__r(0)`. Expo Go's runtime only requires that `__d`/`__r`/`__c`/
 * `__registerSegment` exist and that `__r` boots the app -- this gets a real
 * app rendering with near-zero emitter work while the per-module `__d`
 * emitter (numeric ids, dependencyMaps, metro-runtime prelude) lands next.
 *
 * Unlike the expo-server prototype this makes NO `global.require` fallback:
 * each Expo Go project runs in a fresh Hermes instance whose only JS is this
 * bundle, so everything (react-native core included) must be in the module
 * map.
 */

import { findRequires } from "./utils.js";
import { ModuleIdRegistry } from "./module-ids.js";

const PUBLIC_ENV_PREFIXES = ["EXPO_PUBLIC_", "NEXT_PUBLIC_"];

export interface MetroEmitOptions {
  env?: Record<string, string>;
  /**
   * Module ids required before the entry (Metro's
   * "modulesRunBeforeMainModule"): react-native's InitializeCore sets up
   * error handling, timers, DEV tooling. Ids must exist in the module map.
   */
  preRequires?: string[];
  dev?: boolean;
  /**
   * The real metro-runtime require.js source (flow-stripped +
   * Hermes-lowered), fetched from the package server's /prelude endpoint.
   * When present the emitter produces PER-MODULE `__d(factory, id, deps)`
   * registrations (Milestone B) instead of the single-__d wrapper.
   */
  prelude?: string;
}

/** Metro-style var prelude. `__DEV__` is a real var here -- native package
 *  builds deliberately do NOT define __DEV__ so it binds to this one. */
export function buildMetroPrelude(opts: MetroEmitOptions): string {
  const dev = opts.dev !== false;
  let prelude =
    // Hermes exposes globalThis but not `global` at script scope; RN code and
    // metro-runtime's require.js reference `global` directly.
    "var global = typeof globalThis !== 'undefined' ? globalThis : this;\n" +
    "global.global = global;\n" +
    "var __BUNDLE_START_TIME__ = globalThis.nativePerformanceNow ? nativePerformanceNow() : Date.now();\n" +
    `var __DEV__ = ${dev};\n` +
    "var __METRO_GLOBAL_PREFIX__ = '';\n" +
    "var process = globalThis.process || {};\n" +
    "process.env = process.env || {};\n" +
    `process.env.NODE_ENV = process.env.NODE_ENV || ${JSON.stringify(dev ? "development" : "production")};\n`;
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (PUBLIC_ENV_PREFIXES.some((p) => key.startsWith(p))) {
        prelude += "process.env." + key + " = " + JSON.stringify(value) + ";\n";
      }
    }
  }
  return prelude;
}

/** Minimal Metro module system: just enough for Expo Go's boot contract. */
const MINI_METRO_RUNTIME = `(function(global) {
  'use strict';
  var modules = Object.create(null);
  function define(factory, moduleId, dependencyMap) {
    modules[moduleId] = {
      factory: factory,
      dependencyMap: dependencyMap || [],
      isInitialized: false,
      hasError: false,
      error: undefined,
      publicModule: { exports: {} }
    };
  }
  function metroRequire(moduleId) {
    var mod = modules[moduleId];
    if (!mod) throw new Error('Requiring unknown module: ' + moduleId);
    if (mod.hasError) throw mod.error;
    if (mod.isInitialized) return mod.publicModule.exports;
    mod.isInitialized = true;
    try {
      mod.factory(global, metroRequire, mod.publicModule, mod.publicModule.exports, mod.dependencyMap);
    } catch (e) {
      mod.isInitialized = false;
      mod.hasError = true;
      mod.error = e;
      throw e;
    }
    return mod.publicModule.exports;
  }
  global.__d = define;
  global.__r = metroRequire;
  global.__c = Object.create(null);
  global.__registerSegment = function() {};
})(typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : this);
`;

/**
 * Wrap a string-keyed module map into a single-__d Metro bundle.
 * Inside the factory the familiar CJS registry runs unchanged; requires
 * between modules resolve through the inner registry, never through __r.
 */
/**
 * Escape a module key for use inside a regex.
 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Emit ONE module as a Metro `__d(factory, id, dependencyMap)` registration.
 *
 * The module body arrives with requires already resolved to string keys
 * (VFS paths / npm specifiers); each unique dependency gets an index in the
 * dependencyMap and every `require("<key>")` becomes
 * `require(_dependencyMap[i])`. The factory signature matches metro-runtime's
 * invocation order: (global, require, importDefault, importAll, module,
 * exports, dependencyMap) -- our CJS output only uses require/module/exports.
 *
 * Exported separately so the native HMR server (3C) emits update payloads
 * with EXACTLY the same shape as the bundle.
 */
export function emitMetroModule(
  code: string,
  key: string,
  registry: ModuleIdRegistry,
  opts?: {
    /**
     * Numeric ancestor map ({id: parentIds[]}) passed as __d's 5th argument.
     * REQUIRED for hot updates: metro-runtime's define() treats a
     * redefinition without inverseDependencies as a no-op, and uses the map
     * to walk up to React Refresh boundaries.
     */
    inverseDependencies?: Record<number, number[]>;
  }
): { text: string; depKeys: string[] } {
  const depKeys = [...new Set(findRequires(code))];
  let body = code;
  depKeys.forEach((dep, i) => {
    const re = new RegExp(`require\\(\\s*(?:"${escapeRe(dep)}"|'${escapeRe(dep)}')\\s*\\)`, "g");
    body = body.replace(re, `require(_dependencyMap[${i}])`);
  });
  const id = registry.idFor(key);
  const depIds = depKeys.map((d) => registry.idFor(d));
  const extra = opts?.inverseDependencies
    ? `, ${JSON.stringify(key)}, ${JSON.stringify(opts.inverseDependencies)}`
    : `, ${JSON.stringify(key)}`;
  const text =
    `__d(function (global, require, _importDefault, _importAll, module, exports, _dependencyMap) {\n` +
    body +
    `\n}, ${id}, [${depIds.join(",")}]${extra});`;
  return { text, depKeys };
}

/** One module entry in a Metro HMR update body. */
export interface MetroHmrModuleEntry {
  module: [number, string];
  sourceMappingURL: string | null;
  sourceURL: string;
}

/** Body of a Metro `{type:"update"}` HMR message. */
export interface MetroHmrBody {
  revisionId: string;
  isInitialUpdate: boolean;
  added: MetroHmrModuleEntry[];
  modified: MetroHmrModuleEntry[];
  deleted: number[];
}

/**
 * Convert an HmrUpdate (RAW module bodies -- metro-format sessions skip the
 * web decorations) into a Metro HMR update body. Each module is wrapped with
 * emitMetroModule so injected code is byte-identical in shape to the bundle's
 * own registrations; RN's HMRClient evals these strings and metro-runtime
 * hot-swaps + React-Refreshes.
 */
export function buildMetroHmrBody(
  update: {
    updatedModules: Record<string, string>;
    removedModules: string[];
    reverseDepsMap?: Record<string, string[]>;
  },
  registry: ModuleIdRegistry,
  revisionId: string
): MetroHmrBody {
  // Numeric transitive ancestor map for one module: {id: parentIds[]} for
  // every ancestor on the path(s) up to the roots. metro-runtime walks this
  // to find the nearest React Refresh boundary.
  const reverse = update.reverseDepsMap || {};
  const ancestorsFor = (startKey: string): Record<number, number[]> => {
    const out: Record<number, number[]> = {};
    const queue = [startKey];
    const seen = new Set<string>();
    while (queue.length) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const parents = reverse[key] || [];
      out[registry.idFor(key)] = parents.map((p) => registry.idFor(p));
      queue.push(...parents);
    }
    return out;
  };

  const added: MetroHmrModuleEntry[] = [];
  const modified: MetroHmrModuleEntry[] = [];
  for (const [key, code] of Object.entries(update.updatedModules)) {
    const isNew = !registry.has(key);
    const { text } = emitMetroModule(code, key, registry, {
      inverseDependencies: ancestorsFor(key),
    });
    const entry: MetroHmrModuleEntry = {
      module: [registry.idFor(key), text],
      sourceMappingURL: null,
      sourceURL: key,
    };
    (isNew ? added : modified).push(entry);
  }
  const deleted = update.removedModules.filter((k) => registry.has(k)).map((k) => registry.idFor(k));
  return { revisionId, isInitialUpdate: false, added, modified, deleted };
}

/**
 * Milestone B: per-module `__d` bundle on top of the REAL metro-runtime
 * require.js (opts.prelude). Boot order: vars prelude, metro-runtime,
 * every module registered via __d, then __r for the preRequires
 * (polyfills, InitializeCore) and finally __r(entry).
 */
/** Maps a 1-based bundle line range to the module occupying it. */
export interface BundleLineIndexEntry {
  start: number;
  end: number;
  key: string;
}

export function emitMetroModulesBundle(
  moduleMap: Record<string, string>,
  entryFile: string,
  registry: ModuleIdRegistry,
  opts: MetroEmitOptions,
  /** When provided, filled with per-module line ranges (for /symbolicate). */
  lineIndex?: BundleLineIndexEntry[]
): string {
  const parts: string[] = [buildMetroPrelude(opts), opts.prelude || ""];
  let line = countLines(parts[0]) + countLines(parts[1]);
  for (const key of Object.keys(moduleMap)) {
    const { text } = emitMetroModule(moduleMap[key], key, registry);
    const lines = countLines(text);
    lineIndex?.push({ start: line + 1, end: line + lines, key });
    line += lines;
    parts.push(text);
  }
  for (const pre of opts.preRequires || []) {
    parts.push(`__r(${registry.idFor(pre)});`);
  }
  parts.push(`__r(${registry.idFor(entryFile)});`);
  return parts.join("\n") + "\n";
}

/** Lines a chunk occupies when joined with "\n" (its newline count + 1). */
function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

export function emitMetroWrappedBundle(
  moduleMap: Record<string, string>,
  entryFile: string,
  opts: MetroEmitOptions = {}
): string {
  const moduleEntries = Object.keys(moduleMap)
    .map(
      (id) =>
        JSON.stringify(id) +
        ": function(module, exports, require) {\n" +
        moduleMap[id] +
        "\n}"
    )
    .join(",\n\n");

  const preRequires = (opts.preRequires || [])
    .map((id) => "  require(" + JSON.stringify(id) + ");\n")
    .join("");

  const innerRuntime =
    "(function(modules) {\n" +
    "  var cache = {};\n" +
    "  function require(id) {\n" +
    "    if (cache[id]) return cache[id].exports;\n" +
    "    if (!modules[id]) throw new Error('Module not found: ' + id);\n" +
    "    var module = cache[id] = { exports: {} };\n" +
    "    modules[id].call(module.exports, module, module.exports, require);\n" +
    "    return module.exports;\n" +
    "  }\n" +
    preRequires +
    "  require(" +
    JSON.stringify(entryFile) +
    ");\n" +
    "})({\n" +
    moduleEntries +
    "\n});\n";

  return (
    buildMetroPrelude(opts) +
    MINI_METRO_RUNTIME +
    "__d(function(global, _$$_REQUIRE, module, exports, _dependencyMap) {\n" +
    innerRuntime +
    "}, 0, []);\n" +
    "__r(0);\n"
  );
}
