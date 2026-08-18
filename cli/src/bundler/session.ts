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
import { createHermesLoweringPlugin } from "./hermes-lowering.js";
import { compileNativewindCss } from "../project/nativewind.js";
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
  private everBuilt = false;
  private listeners = new Set<(e: SessionEvent) => void>();

  // nativewind: css path → compiled injectData module (virtualSource reads it).
  private nativewindCss = new Map<string, string>();
  private nwRefreshing = false;
  private nwPending = false;

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
    if (compiled === null) return [];
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

  /** Initial build. Returns true on success. */
  async build(): Promise<boolean> {
    // First bundle should ship styles, so the initial compile is awaited.
    if (this.options.nativewind && this.nativewindCss.size === 0) {
      await this.refreshNativewindCss();
    }
    const entry = ensureEntryFile(this.vfs);
    if (!entry) {
      this.buildError = "No entry file found (looked for /index.*, /App.*, package.json main).";
      this.emit({ type: "build-error", message: this.buildError });
      return false;
    }
    try {
      const result = await this.bundler.build(entry);
      this.bundle = result.bundle;
      this.bundleVersion++;
      this.buildError = null;
      this.everBuilt = true;
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

    // A project that never built (e.g. no entry yet, or a broken first build)
    // retries a full build -- rebuild() needs prior graph state.
    if (!this.everBuilt) {
      const ok = await this.build();
      if (ok) this.emit({ type: "reload", bundleVersion: this.bundleVersion, reason: "initial build" });
      return;
    }

    try {
      this.bundler.updateFS(this.vfs);
      const result = await this.bundler.rebuild(all.map((c) => ({ path: c.path, type: c.type })));
      this.bundle = result.bundle;
      this.bundleVersion++;
      this.buildError = null;

      if (result.type === "full" || !result.hmrUpdate || result.hmrUpdate.requiresReload) {
        this.emit({
          type: "reload",
          bundleVersion: this.bundleVersion,
          reason: result.hmrUpdate?.reloadReason,
        });
      } else {
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
