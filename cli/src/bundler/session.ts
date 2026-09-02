import {
  IncrementalBundler,
  VirtualFS,
  reactRefreshTransformer,
  metroReactRefreshTransformer,
  typescriptTransformer,
  createTypescriptTransformer,
  createReactRefreshTransformer,
  createExpoWebShimsPlugin,
  createUnsupportedWebPackagesPlugin,
  ensureEntryFile,
  applyRouteStructureChanges,
  isApiRouteFile,
  platformSourceExts,
  INITIALIZE_CORE_SUBPATH,
  NATIVE_POLYFILL_SUBPATHS,
} from "browser-metro";
import { randomUUID } from "node:crypto";
import { createHermesLoweringPlugin } from "./hermes-lowering.js";
import { compileNativewindCss } from "../project/nativewind.js";
import { bundleCacheKey, readCachedBundle, writeCachedBundle } from "./bundle-cache.js";
import { HISTORY_LIMIT, mergeHistory, type HistoryEntry } from "./catch-up.js";
import {
  NATIVE_DEV_CLIENT_PATH,
  NATIVE_DEV_CLIENT_SOURCE,
  NATIVE_ENTRY_WRAPPER_PATH,
  nativeEntryWrapperSource,
} from "./native-dev-client.js";
import type {
  BundleLineIndexEntry,
  BundlerConfig,
  BundlePlatform,
  ContentChange,
  FileMap,
  HmrUpdate,
} from "browser-metro";

/**
 * User files can use JSX without importing React (expo projects rely on the
 * automatic runtime under babel). Sucrase emits classic
 * `React.createElement(...)` calls, so inject the require when the file uses
 * React but never imported it. Applies to local files only.
 */
const injectReactPlugin = {
  name: "inject-react",
  transformOutput({ code, filename }: { code: string; filename: string }) {
    if (!filename.startsWith("/")) return null;
    if (!/\bReact\./.test(code)) return null;
    // Only a literal `React` BINDING counts -- sucrase's interop for named
    // imports emits `var _react = require('react')`, which does NOT put
    // `React` in scope for the classic JSX output.
    if (/\b(?:var|const|let|function)\s+React\b/.test(code)) return null;
    return { code: 'var React = require("react");\n' + code };
  },
};

/**
 * nativewind/native: Metro aliases react/jsx-runtime GLOBALLY (css-interop's
 * metro resolver), so JSX inside packages -- RN core's KeyboardAvoidingView,
 * react-navigation internals -- also flows through css-interop's wrapJSX and
 * remapped className styles resolve. Our per-package chunks are compiled
 * against the real runtime, so we override the registry key instead: the
 * real runtime stays at react/jsx-runtime__original and every chunk's
 * require("react/jsx-runtime") gets the wrapped one. ES5 only: overrides
 * skip the transform pipeline.
 */
const nativewindGlobalJsxPlugin = {
  name: "nativewind-global-jsx",
  overrideModules() {
    return {
      "react/jsx-runtime":
        'var _real = require("react/jsx-runtime__original");\n' +
        // LAZY: react/jsx-runtime is required by RN core itself, BEFORE
        // InitializeCore installs native modules. Requiring css-interop's
        // runtime at module scope crashes there (its appearance observable
        // reads Appearance.getColorScheme on an undefined native module), so
        // the wrapper is built on the first JSX call instead -- by then the
        // app is rendering and the runtime is up.
        "var _cache = null;\n" +
        "function _wrapped(name) {\n" +
        "  return function () {\n" +
        "    if (_cache === null) {\n" +
        '      var m = require("react-native-css-interop/dist/runtime/wrap-jsx");\n' +
        "      var w = m.default || m;\n" +
        "      _cache = { jsx: w(_real.jsx), jsxs: w(_real.jsxs) };\n" +
        "      if (_real.jsxDEV) _cache.jsxDEV = w(_real.jsxDEV);\n" +
        "    }\n" +
        "    return _cache[name].apply(null, arguments);\n" +
        "  };\n" +
        "}\n" +
        "module.exports = {\n" +
        "  Fragment: _real.Fragment,\n" +
        '  jsx: _wrapped("jsx"),\n' +
        '  jsxs: _wrapped("jsxs")\n' +
        "};\n" +
        'if (_real.jsxDEV) module.exports.jsxDEV = _wrapped("jsxDEV");\n',
    };
  },
};

export type SessionEvent =
  | { type: "hmr"; update: HmrUpdate; bundleVersion: number }
  | { type: "reload"; bundleVersion: number; reason?: string }
  | { type: "build-error"; message: string };

export interface SessionOptions {
  packageServerUrl: string;
  env: Record<string, string>;
  platform?: BundlePlatform;
  assetPublicPath: string;
  /** metro-runtime require.js (native only; enables per-module __d + HMR). */
  metroPrelude?: string;
  /** Asset dimensions + hashes from the scanner (native AssetRegistry). */
  assetMeta?: Record<string, { width?: number; height?: number; hash: string }>;
  /** Custom fetch (the CLI's disk-cached fetch). */
  fetch?: typeof fetch;
  /**
   * nativewind mode (native sessions): JSX routes through nativewind's
   * jsx-runtime and `.css` imports become compiled injectData modules
   * supplied via setNativewindCss().
   */
  nativewind?: boolean;
  /** Logger for non-fatal problems (defaults to console.warn). */
  warn?: (msg: string) => void;
  /** Resolved react-native-worklets babel plugin (native reanimated support). */
  workletsPluginPath?: string | null;
  /** rnrun + browser-metro versions; part of the bundle-cache key. */
  toolVersions?: string;
}

/**
 * Owns one VirtualFS + IncrementalBundler pair for one platform and tracks
 * bundle/version/error state. Ported from the lifo prototype's semantics,
 * sandbox-free:
 *  - a failed initial build serves the error (no bundle yet);
 *  - a failed rebuild keeps serving the last good bundle and self-heals on
 *    the next successful rebuild.
 */
export class BundlerSession {
  readonly platform: BundlePlatform;
  private vfs: VirtualFS;
  private bundler: IncrementalBundler;
  private options: SessionOptions;

  private bundle = "";
  bundleVersion = 0;
  buildError: string | null = null;
  /**
   * Identity of this session's module-id space. The bundler mints numeric ids
   * as it first sees modules, so two sessions (a re-init, a restart) number
   * the same files differently, and a patch from one applied to a bundle
   * from the other requires ids that were never defined. The server records
   * the epoch it served to each device (server/clients.ts) and reloads the
   * device when the session it is patching from is not that one. Stable
   * across builds within the session: the IncrementalBundler (and its id
   * registry) is created once, in the constructor.
   */
  readonly epoch = randomUUID().slice(0, 8);
  /** Applied rebuilds, newest last, so a client that missed patches between
   *  fetching its bundle and registering on /hot can be caught up (catchUp). */
  private history: HistoryEntry[] = [];
  /**
   * VFS files the session writes itself (synthetic expo-router entry and
   * route context, the native dev client) -- derived from the project files,
   * so excluded from the bundle-cache key. Including them made the key differ
   * between boot (computed before they exist) and every later write (after),
   * so the bundle persisted after an edit never matched on the next wake and
   * the fleet paid a full build on every wake that followed an edit.
   */
  private syntheticPaths = new Set<string>();
  private everBuilt = false;
  private buildingOnce: Promise<boolean> | null = null;
  /** Serving a bundle restored from disk (no module graph yet). */
  restoredFromCache = false;
  /** The bundler holds a live module graph (needed for incremental rebuilds).
   *  False after a cache-hit serve until the first edit forces a real build. */
  private graphBuilt = false;
  private listeners = new Set<(e: SessionEvent) => void>();

  // nativewind: css path → compiled injectData module (virtualSource reads it).
  private nativewindCss = new Map<string, string>();
  private nwRefreshing = false;
  private nwPending = false;
  /** The last nativewind compile failed (package server down, 413, ...). The
   *  bundle then has no compiled CSS -- serve it (better than nothing) but
   *  never persist it: a cached degraded bundle would keep being served on
   *  every wake with the same inputs, long after the server recovered. */
  private nativewindFailed = false;

  constructor(files: FileMap, options: SessionOptions) {
    this.options = options;
    this.platform = options.platform ?? "web";
    this.vfs = new VirtualFS(files);
    this.bundler = new IncrementalBundler(this.vfs, this.buildConfig());
  }

  private projectDeps(): Record<string, string> {
    try {
      const pkg = JSON.parse(this.vfs.read("/package.json") || "{}");
      return pkg.dependencies || {};
    } catch {
      return {};
    }
  }

  private buildConfig(): BundlerConfig {
    const web = this.platform === "web";
    const deps = this.projectDeps();
    // Both of these trigger package-server fetches (react-native-web via the
    // shim alias, react-refresh/runtime via the HMR runtime), so only enable
    // them when the project actually uses React / React Native.
    const hasReact = "react" in deps || "react-native" in deps || "expo" in deps;
    const hasRn = "react-native" in deps || "expo" in deps;

    if (!web) {
      // Native (Expo Go): Metro-format output, InitializeCore before the
      // entry, no web plugins/shims. Fast Refresh and the /hot protocol land
      // with the per-module __d emitter; until then edits are full reloads.
      // nativewind projects compile JSX through nativewind's jsx-runtime so
      // className props reach css-interop's wrapped components.
      const nwBase = this.options.nativewind
        ? createTypescriptTransformer({ jsxRuntime: "automatic", jsxImportSource: "nativewind" })
        : typescriptTransformer;
      const nativeTransformer = this.options.nativewind
        ? createReactRefreshTransformer(nwBase, "metro")
        : metroReactRefreshTransformer;
      return {
        resolver: { sourceExts: platformSourceExts(this.platform) },
        platform: this.platform,
        // Metro-convention Fast Refresh registration; metro-runtime supplies
        // $RefreshReg$/$RefreshSig$ during factory execution in DEV.
        transformer: hasReact ? nativeTransformer : nwBase,
        virtualSource: this.options.nativewind
          ? (p: string) => this.nativewindCss.get(p)
          : undefined,
        server: { packageServerUrl: this.options.packageServerUrl, fetch: this.options.fetch },
      log: this.options.warn,
        // hmr.enabled makes rebuilds produce HmrUpdate payloads (raw module
        // bodies in metro format); the emitter itself ignores this flag.
        hmr: { enabled: !!this.options.metroPrelude },
        output: {
          format: "metro",
          // Metro's prelude order: polyfills (console, error-guard) install
          // global.ErrorUtils etc., then InitializeCore, then the entry.
          preRequires:
            "react-native" in deps ? [...NATIVE_POLYFILL_SUBPATHS, INITIALIZE_CORE_SUBPATH] : [],
          prelude: this.options.metroPrelude,
        },
        plugins: [
          ...(hasReact ? [injectReactPlugin] : []),
          ...(this.options.nativewind ? [nativewindGlobalJsxPlugin] : []),
          createHermesLoweringPlugin({ workletsPluginPath: this.options.workletsPluginPath }),
        ],
        env: this.options.env,
        assetPublicPath: this.options.assetPublicPath,
        assetMeta: this.options.assetMeta,
      };
    }

    // nativewind on web: JSX through nativewind's jsx-runtime (css-interop's
    // web runtime maps className to the DOM) + the project's .css imports
    // become <style>-injection modules via virtualSource.
    const webBase = this.options.nativewind
      ? createTypescriptTransformer({ jsxRuntime: "automatic", jsxImportSource: "nativewind" })
      : typescriptTransformer;
    return {
      resolver: { sourceExts: platformSourceExts(this.platform) },
      platform: this.platform,
      transformer: this.options.nativewind
        ? createReactRefreshTransformer(webBase)
        : reactRefreshTransformer,
      virtualSource: this.options.nativewind
        ? (p: string) => this.nativewindCss.get(p)
        : undefined,
      server: { packageServerUrl: this.options.packageServerUrl, fetch: this.options.fetch },
      log: this.options.warn,
      hmr: { enabled: true, reactRefresh: hasReact },
      plugins: [
        ...(hasReact ? [injectReactPlugin] : []),
        ...(hasRn ? [createExpoWebShimsPlugin(), createUnsupportedWebPackagesPlugin()] : []),
      ],
      env: this.options.env,
      // Pages are served from a real http origin -- no blob-iframe router shim.
      routerShim: false,
      assetPublicPath: this.options.assetPublicPath,
    };
  }

  onEvent(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  getBundle(): string {
    return this.bundle;
  }

  getVfs(): VirtualFS {
    return this.vfs;
  }

  /** Stable numeric module ids (metro-format sessions; used by the /hot server). */
  getModuleIds() {
    return this.bundler.moduleIds;
  }

  /**
   * The one patch that takes a client holding bundleVersion `from` to the
   * current bundle (empty when it is current), or null when only a reload can
   * -- a full rebuild happened since, or the history no longer reaches back.
   */
  catchUp(from: number): HmrUpdate | null {
    return mergeHistory(this.history, from, this.bundleVersion);
  }

  private recordHistory(update: HmrUpdate | null): void {
    this.history.push({ version: this.bundleVersion, update });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  /**
   * Native bundles boot through a wrapper that loads the dev client before
   * the app (see native-dev-client.ts). Only for metro-format sessions of
   * projects that actually depend on react-native: the client is inert
   * without RN, and requiring it from a project that doesn't declare it
   * would fail resolution.
   */
  private nativeBuildEntry(entry: string): string {
    if (this.platform === "web" || !this.options.metroPrelude) return entry;
    if (!("react-native" in this.projectDeps())) return entry;
    this.vfs.write(NATIVE_DEV_CLIENT_PATH, NATIVE_DEV_CLIENT_SOURCE);
    this.vfs.write(NATIVE_ENTRY_WRAPPER_PATH, nativeEntryWrapperSource(entry));
    this.syntheticPaths.add(NATIVE_DEV_CLIENT_PATH);
    this.syntheticPaths.add(NATIVE_ENTRY_WRAPPER_PATH);
    return NATIVE_ENTRY_WRAPPER_PATH;
  }

  /** Bundle-line → module ranges from the last metro emit (for /symbolicate). */
  getNativeLineIndex(): BundleLineIndexEntry[] {
    return this.bundler.nativeLineIndex;
  }

  /**
   * Recompile nativewind CSS from current VFS state. Returns css paths whose
   * compiled module changed. A failed compile keeps the previous modules.
   */
  private async refreshNativewindCss(): Promise<string[]> {
    if (!this.options.nativewind) return [];
    const compiled = await compileNativewindCss({
      vfs: this.vfs,
      platform: this.platform,
      packageServerUrl: this.options.packageServerUrl,
      fetch: this.options.fetch,
      warn: this.options.warn ?? ((msg) => console.warn(msg)),
    });
    if (compiled === null) {
      this.nativewindFailed = true;
      return [];
    }
    this.nativewindFailed = false;
    const changed: string[] = [];
    for (const [p, code] of compiled) {
      if (this.nativewindCss.get(p) !== code) {
        this.nativewindCss.set(p, code);
        changed.push(p);
      }
    }
    return changed;
  }

  /**
   * Fast Refresh must not wait on a tailwind round-trip, so rebuilds kick the
   * recompile in the background; when new classNames change the compiled CSS,
   * the css module lands as a follow-up HMR update (matching nativewind's own
   * watcher-driven behavior under Metro). Coalesces concurrent runs.
   */
  private scheduleNativewindRefresh(): void {
    if (!this.options.nativewind) return;
    if (this.nwRefreshing) {
      this.nwPending = true;
      return;
    }
    this.nwRefreshing = true;
    void (async () => {
      try {
        do {
          this.nwPending = false;
          const changed = await this.refreshNativewindCss();
          if (changed.length > 0) {
            await this.applyChanges(
              changed.map((p) => ({ type: "update" as const, path: p, content: this.vfs.read(p) }))
            );
          }
        } while (this.nwPending);
      } catch {
        // refreshNativewindCss already warns; never crash the session.
      } finally {
        this.nwRefreshing = false;
      }
    })();
  }

  /**
   * Build once, coalescing concurrent callers. Lets a platform's first request
   * trigger its build instead of paying for it at startup: a container woken
   * by a phone scan should not build a web bundle nobody asked for.
   */
  ensureBuilt(): Promise<boolean> {
    if (this.everBuilt) return Promise.resolve(true);
    if (!this.buildingOnce) {
      this.buildingOnce = this.build().finally(() => {
        this.buildingOnce = null;
      });
    }
    return this.buildingOnce;
  }

  /** Cache key for the CURRENT VFS + config state (project files only -- see
   *  syntheticPaths). */
  private cacheKey(): string {
    const files = { ...this.vfs.toFileMap() };
    for (const p of this.syntheticPaths) delete files[p];
    return bundleCacheKey({
      platform: this.platform,
      toolVersions: this.options.toolVersions ?? "unknown",
      files,
      assetMeta: this.options.assetMeta,
      env: this.options.env,
      prelude: this.options.metroPrelude,
      flags: {
        nativewind: !!this.options.nativewind,
        worklets: !!this.options.workletsPluginPath,
        assetPublicPath: this.options.assetPublicPath,
        packageServerUrl: this.options.packageServerUrl,
      },
    });
  }

  /**
   * Initial build. Tries the on-disk bundle cache first: a restart (or a
   * scale-to-zero container wake) then serves in milliseconds instead of
   * re-assembling. A background build still runs, because HMR needs the module
   * graph that a cached bundle doesn't carry -- and since the inputs are
   * identical the rebuilt bytes should match, so clients are never disturbed.
   */
  async build(): Promise<boolean> {
    const key = this.cacheKey();
    const cached = readCachedBundle(key);
    if (cached && !this.everBuilt) {
      // Serve the persisted bundle and STOP: no eager rebuild. The module
      // graph (needed only for Fast Refresh) is built lazily on the first
      // edit instead. This is what makes a scale-to-zero wake cost ~0 -- an
      // unconditional background rebuild here burned a full build of CPU on
      // every wake even when nobody would ever edit (and made --prewarm
      // actively harmful: a scan coalesced onto that rebuild instead of the
      // cache). The cache key already covers every input, so a hit means the
      // bytes are current.
      this.bundle = cached;
      this.bundleVersion++;
      this.buildError = null;
      this.everBuilt = true;
      this.graphBuilt = false;
      this.restoredFromCache = true;
      this.recordHistory(null);
      this.options.warn?.(
        `[${this.platform}] served a cached bundle (${(cached.length / 1024).toFixed(0)} KB); module graph builds lazily on first edit`
      );
      return true;
    }
    return this.realBuild(key);
  }

  /** Build from the current VFS, populating the module graph. Never serves the
   *  cache -- callers use this when a live graph is required (a miss, or the
   *  first edit after a cache-hit serve). */
  private async realBuild(key: string): Promise<boolean> {
    if (this.options.nativewind && this.nativewindCss.size === 0) {
      await this.refreshNativewindCss();
    }
    const before = new Set(Object.keys(this.vfs.toFileMap()));
    const entry = ensureEntryFile(this.vfs);
    // Whatever ensureEntryFile wrote (expo-router's /index.tsx + /__expo_ctx.js)
    // is derived from the project files, not one of them.
    for (const p of Object.keys(this.vfs.toFileMap())) if (!before.has(p)) this.syntheticPaths.add(p);
    if (!entry) {
      this.buildError = "No entry file found (looked for /index.*, /App.*, package.json main).";
      this.emit({ type: "build-error", message: this.buildError });
      return false;
    }
    try {
      const result = await this.bundler.build(this.nativeBuildEntry(entry));
      this.bundle = result.bundle;
      this.bundleVersion++;
      this.buildError = null;
      this.everBuilt = true;
      this.graphBuilt = true;
      this.restoredFromCache = false;
      // A fresh graph: nothing a client on an earlier version can be patched
      // up to (ids may have been re-minted), hence the null entry.
      this.recordHistory(null);
      if (!this.nativewindFailed) writeCachedBundle(key, result.bundle);
      return true;
    } catch (err) {
      this.buildError = errText(err);
      this.emit({ type: "build-error", message: this.buildError });
      return false;
    }
  }

  /**
   * Apply file changes and rebuild. Content changes are applied to the VFS
   * here; the route context is regenerated when route files appear/disappear.
   */
  async applyChanges(changes: ContentChange[]): Promise<void> {
    if (changes.length === 0) return;

    for (const change of changes) {
      if (change.type === "delete") this.vfs.delete(change.path);
      else this.vfs.write(change.path, change.content ?? "");
    }

    const ctxChange = applyRouteStructureChanges(this.vfs, changes);
    // +api handlers are excluded from the client bundle (they may import
    // Node-side modules); rebuilding them here would fail the client rebuild.
    const clientChanges = changes.filter((c) => !isApiRouteFile(c.path));
    const all = ctxChange ? [...clientChanges, ctxChange] : clientChanges;
    if (all.length === 0) return;

    // No live module graph yet -- never built, or served from cache and this is
    // the first edit. A full build establishes the graph AND applies these
    // changes (already written to the VFS above); only the first edit pays it,
    // and subsequent edits are incremental. realBuild bypasses the cache serve
    // so we get a real graph rather than the cached bytes again.
    if (!this.everBuilt || !this.graphBuilt) {
      const ok = await this.realBuild(this.cacheKey());
      if (ok) this.emit({ type: "reload", bundleVersion: this.bundleVersion, reason: "initial build" });
      return;
    }

    try {
      this.bundler.updateFS(this.vfs);
      const result = await this.bundler.rebuild(all.map((c) => ({ path: c.path, type: c.type })));
      this.bundle = result.bundle;
      this.bundleVersion++;
      this.buildError = null;
      // Persist after edits too, so the next wake starts warm at the CURRENT
      // state rather than the state the process started from.
      if (!this.nativewindFailed) writeCachedBundle(this.cacheKey(), result.bundle);

      if (result.type === "full" || !result.hmrUpdate || result.hmrUpdate.requiresReload) {
        this.recordHistory(null);
        this.emit({
          type: "reload",
          bundleVersion: this.bundleVersion,
          reason: result.hmrUpdate?.reloadReason,
        });
      } else {
        this.recordHistory(result.hmrUpdate);
        this.emit({ type: "hmr", update: result.hmrUpdate, bundleVersion: this.bundleVersion });
      }
      // Source/css edits may change tailwind's output; recompile without
      // blocking this rebuild (self-applies as a follow-up change if so).
      this.scheduleNativewindRefresh();
    } catch (err) {
      // Keep serving the last good bundle; surface the error and self-heal
      // on the next successful rebuild.
      this.buildError = errText(err);
      this.emit({ type: "build-error", message: this.buildError });
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.stack || err.message : String(err);
}
