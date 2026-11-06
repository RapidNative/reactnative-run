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
  nativePostCoreSubpaths,
} from "browser-metro";
import { randomUUID } from "node:crypto";
import { createHermesLoweringPlugin } from "./hermes-lowering.js";
import { compileNativewindCss } from "../project/nativewind.js";
import { bundleCacheKey, readCachedBundle, readCachedBundleMeta, writeCachedBundle } from "./bundle-cache.js";
import { HISTORY_LIMIT, mergeHistory, type HistoryEntry } from "./catch-up.js";
import { DOM_ENTRY_PATH, DOM_PROXY_VERSION, createUseDomNativePlugin, domEntrySource } from "./dom-components.js";
import {
  NATIVE_DEV_CLIENT_PATH,
  NATIVE_DEV_CLIENT_SOURCE,
  NATIVE_ENTRY_WRAPPER_PATH,
  NATIVE_PRE_ENTRY_PATH,
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
  /**
   * Web sessions only: build the web bundle of this Expo DOM component (a
   * "use dom" file's VFS path) instead of the app -- what the WebView in the
   * native app loads (dom-components.ts).
   */
  domEntry?: string;
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
   * registry) is created once, in the constructor. A session that serves a
   * cached bundle takes over the epoch and ids that bundle was made with
   * (build), so devices running it stay patchable across a restart.
   */
  epoch = randomUUID().slice(0, 8);
  /**
   * Names the bundle a device runs: epoch, version, and this process's run id,
   * so a version number reused after a restart never names other bytes. It is
   * the manifest's launch-asset key, and the anonymous dev client reports it
   * (updated as patches land) instead of relying on its URL token.
   */
  bundleTag: string;
  private readonly run = randomUUID().slice(0, 6);
  /** Ids restored with a cached bundle (0 when none were). */
  private restoredIds = 0;
  /** The graph built for a cached bundle didn't match it: the next rebuild
   *  must reload devices rather than patch them. */
  private reloadOnNextRebuild = false;
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
  /** css files the last nativewind compile couldn't compile (empty modules).
   *  A bundle that imports one is degraded and not persisted, like above; one
   *  that doesn't (a web-only stylesheet in a native bundle) is fine. */
  private nativewindFailedFiles: string[] = [];

  constructor(files: FileMap, options: SessionOptions) {
    this.options = options;
    this.platform = options.platform ?? "web";
    this.vfs = new VirtualFS(files);
    this.bundler = new IncrementalBundler(this.vfs, this.buildConfig());
    this.bundleTag = this.makeTag();
  }

  private makeTag(): string {
    return `${this.epoch}-${this.bundleVersion}-${this.run}`;
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
          // global.ErrorUtils etc., then InitializeCore, then the entry. Expo's
          // streams polyfill (global ReadableStream) goes after InitializeCore:
          // requiring it evaluates the whole expo chunk (see nativePostCoreSubpaths).
          preRequires:
            "react-native" in deps
              ? [...NATIVE_POLYFILL_SUBPATHS, INITIALIZE_CORE_SUBPATH, ...nativePostCoreSubpaths(deps)]
              : [],
          prelude: this.options.metroPrelude,
        },
        plugins: [
          ...(hasReact ? [injectReactPlugin] : []),
          ...(this.options.nativewind ? [nativewindGlobalJsxPlugin] : []),
          // "use dom" modules become WebView proxies (before sucrase sees them).
          createUseDomNativePlugin(),
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

  /** The version a device reporting `tag` runs, if it is one of this session's. */
  versionForTag(tag: string): number | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].tag === tag) return this.history[i].version;
    }
    return null;
  }

  /** The tag of an earlier `version`, if the history still holds it. */
  tagFor(version: number): string | null {
    return this.history.find((e) => e.version === version)?.tag ?? null;
  }

  private recordHistory(update: HmrUpdate | null): void {
    this.history.push({ version: this.bundleVersion, update, tag: this.bundleTag });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  /** A new bundle: next version, its tag, and how a client gets to it. */
  private advance(update: HmrUpdate | null): void {
    this.bundleVersion++;
    this.bundleTag = this.makeTag();
    this.recordHistory(update);
  }

  private writeCache(key: string): void {
    if (this.nativewindFailed) return;
    // A module of the bundle is a css file that didn't compile: degraded.
    if (this.nativewindFailedFiles.some((p) => this.bundle.includes(JSON.stringify(p)))) return;
    writeCachedBundle(key, this.bundle, {
      epoch: this.epoch,
      version: this.bundleVersion,
      tag: this.bundleTag,
      moduleIds: this.bundler.moduleIds.entries(),
    });
  }

  /**
   * Number the module ids as `ids` did, so a graph built from the same files
   * re-mints exactly the ids a cached bundle was emitted with. The registry
   * hands out 0, 1, 2... in order, so replaying the keys in id order restores
   * it; anything else (gaps, a registry already in use) is refused.
   */
  private seedModuleIds(ids: Array<[string, number]>): boolean {
    const registry = this.bundler.moduleIds;
    if (registry.entries().length > 0) return false;
    const sorted = [...ids].sort((a, b) => a[1] - b[1]);
    if (sorted.some(([key, id], i) => typeof key !== "string" || id !== i)) return false;
    for (const [key] of sorted) registry.idFor(key);
    this.restoredIds = sorted.length;
    return true;
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
    const preEntry = this.vfs.read(NATIVE_PRE_ENTRY_PATH) ? NATIVE_PRE_ENTRY_PATH : null;
    this.vfs.write(NATIVE_ENTRY_WRAPPER_PATH, nativeEntryWrapperSource(entry, preEntry));
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
    const failed: string[] = [];
    const compiled = await compileNativewindCss({
      vfs: this.vfs,
      platform: this.platform,
      packageServerUrl: this.options.packageServerUrl,
      fetch: this.options.fetch,
      warn: this.options.warn ?? ((msg) => console.warn(msg)),
      failed,
    });
    if (compiled === null) {
      this.nativewindFailed = true;
      return [];
    }
    this.nativewindFailed = false;
    this.nativewindFailedFiles = failed;
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
        // Synthetic, so not in `files`; a change to it between releases must
        // still miss the cache, or a restart serves the old client.
        devClient: this.platform === "web" ? null : NATIVE_DEV_CLIENT_SOURCE,
        // Native output of "use dom" modules; and which DOM component a web
        // session bundles (same files as the app's web bundle otherwise).
        domProxy: this.platform === "web" ? null : DOM_PROXY_VERSION,
        domEntry: this.options.domEntry ?? null,
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
      this.buildError = null;
      this.everBuilt = true;
      this.graphBuilt = false;
      this.restoredFromCache = true;
      // Take over the identity and module ids the bundle was made with, so a
      // device still running it (a phone left open across a sleep/wake) is
      // current here, and the first edit can be patched (adoptCachedBundle).
      const meta = readCachedBundleMeta(key, cached);
      if (meta && this.seedModuleIds(meta.moduleIds)) {
        this.epoch = meta.epoch;
        this.bundleVersion = meta.version;
        this.bundleTag = meta.tag;
        this.recordHistory(null);
      } else {
        this.advance(null);
      }
      this.options.warn?.(
        `[${this.platform}] served a cached bundle (${(cached.length / 1024).toFixed(0)} KB); module graph builds lazily on first edit`
      );
      return true;
    }
    return this.realBuild(key);
  }

  /**
   * Assemble a bundle from the current VFS, populating the module graph.
   * Null when there is no entry file; throws on a build error.
   */
  private async assemble(): Promise<string | null> {
    // The CSS compile is a package-server round trip (~2s, more when cold) and
    // only the module walk reads its result, so let it overlap the dependency
    // prefetch instead of running ahead of it.
    const nativewindReady =
      this.options.nativewind && this.nativewindCss.size === 0
        ? this.refreshNativewindCss().catch(() => {
            this.nativewindFailed = true;
          })
        : undefined;
    if (this.options.domEntry) {
      if (!this.vfs.exists(this.options.domEntry)) return null;
      this.vfs.write(DOM_ENTRY_PATH, domEntrySource(this.options.domEntry));
      this.syntheticPaths.add(DOM_ENTRY_PATH);
      const result = await this.bundler.build(DOM_ENTRY_PATH, nativewindReady);
      return result.bundle;
    }
    const before = new Set(Object.keys(this.vfs.toFileMap()));
    const entry = ensureEntryFile(this.vfs);
    // Whatever ensureEntryFile wrote (expo-router's /index.tsx + /__expo_ctx.js)
    // is derived from the project files, not one of them.
    for (const p of Object.keys(this.vfs.toFileMap())) if (!before.has(p)) this.syntheticPaths.add(p);
    if (!entry) return null;
    const result = await this.bundler.build(this.nativeBuildEntry(entry), nativewindReady);
    return result.bundle;
  }

  /** Build from the current VFS, populating the module graph. Never serves the
   *  cache -- callers use this when a live graph is required (a miss, or the
   *  first edit after a cache-hit serve that adoptCachedBundle couldn't take). */
  private async realBuild(key: string): Promise<boolean> {
    try {
      const bundle = await this.assemble();
      if (bundle === null) {
        this.buildError = "No entry file found (looked for /index.*, /App.*, package.json main).";
        this.emit({ type: "build-error", message: this.buildError });
        return false;
      }
      this.bundle = bundle;
      this.buildError = null;
      this.everBuilt = true;
      this.graphBuilt = true;
      this.restoredFromCache = false;
      // A fresh graph: nothing a client on an earlier version can be patched
      // up to (ids may have been re-minted), hence the null entry.
      this.advance(null);
      this.writeCache(key);
      return true;
    } catch (err) {
      this.buildError = errText(err);
      this.emit({ type: "build-error", message: this.buildError });
      return false;
    }
  }

  /**
   * The first edit after serving a cached bundle. Build the module graph for
   * the files that bundle was made from, BEFORE the edit lands, so the edit
   * becomes an ordinary patch. Building it from the edited files instead (the
   * old way) meant a full rebuild and a reload, and in Expo Go's anonymous
   * mode a reload replays the bundle the phone first downloaded: every preview
   * woke stale on iPhones.
   *
   * The new graph matches the served bundle when it emits the same bytes, or
   * when it numbered every module with the restored ids (same inputs, same
   * ids: the same modules; only their order in the file can differ). False if
   * the build failed; the caller then falls back to a full build.
   */
  private async adoptCachedBundle(): Promise<boolean> {
    const started = performance.now();
    let bundle: string | null;
    try {
      bundle = await this.assemble();
    } catch {
      return false;
    }
    if (bundle === null) return false;
    this.graphBuilt = true;
    this.restoredFromCache = false;
    const ms = Math.round(performance.now() - started);
    const sameIds = this.restoredIds > 0 && this.bundler.moduleIds.entries().length === this.restoredIds;
    if (bundle === this.bundle || sameIds) {
      this.options.warn?.(`[${this.platform}] built the module graph for the cached bundle in ${ms}ms; edits are patches from here`);
      return true;
    }
    // Numbered differently from what devices run: patches would name the
    // wrong modules. Serve the new bytes and reload on this edit.
    this.bundle = bundle;
    this.advance(null);
    this.reloadOnNextRebuild = true;
    this.options.warn?.(`[${this.platform}] the module graph didn't match the cached bundle (${ms}ms); devices reload on this edit`);
    return true;
  }

  /**
   * Apply file changes and rebuild. Content changes are applied to the VFS
   * here; the route context is regenerated when route files appear/disappear.
   */
  async applyChanges(changes: ContentChange[]): Promise<void> {
    if (changes.length === 0) return;

    if (this.everBuilt && !this.graphBuilt) await this.adoptCachedBundle();

    for (const change of changes) {
      if (change.type === "delete") this.vfs.delete(change.path);
      else this.vfs.write(change.path, change.content ?? "");
    }

    // A DOM component's bundle has no route context.
    const ctxChange = this.options.domEntry ? null : applyRouteStructureChanges(this.vfs, changes);
    // +api handlers are excluded from the client bundle (they may import
    // Node-side modules); rebuilding them here would fail the client rebuild.
    const clientChanges = changes.filter((c) => !isApiRouteFile(c.path));
    const all = ctxChange ? [...clientChanges, ctxChange] : clientChanges;
    if (all.length === 0) return;

    // No live module graph yet -- never built, or served from cache and
    // adoptCachedBundle failed. A full build establishes the graph AND applies
    // these changes (already written to the VFS above); subsequent edits are
    // incremental. realBuild bypasses the cache serve so we get a real graph
    // rather than the cached bytes again.
    if (!this.everBuilt || !this.graphBuilt) {
      const ok = await this.realBuild(this.cacheKey());
      if (ok) this.emit({ type: "reload", bundleVersion: this.bundleVersion, reason: "initial build" });
      return;
    }

    try {
      this.bundler.updateFS(this.vfs);
      const result = await this.bundler.rebuild(all.map((c) => ({ path: c.path, type: c.type })));
      // Nothing the bundle contains changed (a file no module imports: notes,
      // eas.json, a log written into the project): no new version, and above
      // all no reload. A rebuild without an HMR update otherwise reads as
      // "reload every device" -- writing a log file into the project reloaded
      // phones every second, mid-boot ("Cannot read property 'EventEmitter'
      // of undefined", then "main has not been registered").
      if (result.bundle === this.bundle && !this.buildError) return;
      this.bundle = result.bundle;
      this.buildError = null;
      const patch =
        this.reloadOnNextRebuild || result.type === "full" || !result.hmrUpdate || result.hmrUpdate.requiresReload
          ? null
          : result.hmrUpdate;
      this.reloadOnNextRebuild = false;
      this.advance(patch);
      // Persist after edits too, so the next wake starts warm at the CURRENT
      // state rather than the state the process started from.
      this.writeCache(this.cacheKey());

      if (!patch) {
        this.emit({
          type: "reload",
          bundleVersion: this.bundleVersion,
          reason: result.hmrUpdate?.reloadReason,
        });
      } else {
        this.emit({ type: "hmr", update: patch, bundleVersion: this.bundleVersion });
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
