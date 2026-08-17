import {
  IncrementalBundler,
  VirtualFS,
  reactRefreshTransformer,
  metroReactRefreshTransformer,
  typescriptTransformer,
  createExpoWebShimsPlugin,
  createUnsupportedWebPackagesPlugin,
  ensureEntryFile,
  applyRouteStructureChanges,
  isApiRouteFile,
  platformSourceExts,
  INITIALIZE_CORE_SUBPATH,
  NATIVE_POLYFILL_SUBPATHS,
} from "browser-metro";
import { hermesLoweringPlugin } from "./hermes-lowering.js";
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
    if (!/React\.createElement|React\.Fragment/.test(code)) return null;
    if (/\brequire\(['"]react['"]\)|\bvar React\b|\bconst React\b|\blet React\b/.test(code)) return null;
    return { code: 'var React = require("react");\n' + code };
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
      return {
        resolver: { sourceExts: platformSourceExts(this.platform) },
        platform: this.platform,
        // Metro-convention Fast Refresh registration; metro-runtime supplies
        // $RefreshReg$/$RefreshSig$ during factory execution in DEV.
        transformer: hasReact ? metroReactRefreshTransformer : typescriptTransformer,
        server: { packageServerUrl: this.options.packageServerUrl },
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
        plugins: [...(hasReact ? [injectReactPlugin] : []), hermesLoweringPlugin],
        env: this.options.env,
        assetPublicPath: this.options.assetPublicPath,
        assetMeta: this.options.assetMeta,
      };
    }

    return {
      resolver: { sourceExts: platformSourceExts(this.platform) },
      platform: this.platform,
      transformer: reactRefreshTransformer,
      server: { packageServerUrl: this.options.packageServerUrl },
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

  /** Initial build. Returns true on success. */
  async build(): Promise<boolean> {
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
