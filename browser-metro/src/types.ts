import type { RawSourceMap } from "./source-map.js";

export interface FileEntry {
  content: string;
  isExternal: boolean;
}

export interface FileMap {
  [path: string]: FileEntry;
}

export interface ModuleMap {
  [id: string]: string;
}

export interface TransformResult {
  code: string;
  sourceMap?: RawSourceMap;
}

export interface TransformParams {
  src: string;
  filename: string;
}

export interface Transformer {
  transform(params: TransformParams): TransformResult;
}

export interface ResolverConfig {
  sourceExts: string[]; // e.g. ['js', 'ts', 'tsx', 'jsx']
  paths?: Record<string, string[]>; // tsconfig "paths", e.g. { "@/*": ["./*"] }
}

export interface BundlerPlugin {
  name: string;

  /** Runs BEFORE Sucrase. Receives raw .tsx/.ts source (JSX still intact). */
  transformSource?(params: { src: string; filename: string }): { src: string } | null;

  /** Runs AFTER Sucrase. Receives CommonJS output. */
  transformOutput?(params: { code: string; filename: string }): { code: string } | null;

  /** Custom module resolution. Return a resolved path or npm name, or null to fall through. */
  resolveRequest?(context: { fromFile: string }, moduleName: string): string | null;

  /**
   * Module aliases. Returns a map of `{ source: target }`.
   * The bundler injects shim modules so `require(source)` re-exports `target`.
   * Works for ALL require calls -- local files and npm packages alike.
   */
  moduleAliases?(): Record<string, string>;

  /**
   * Module shims. Returns a map of `{ moduleName: inlineCode }`.
   * Replaces npm packages with lightweight inline implementations.
   * Shimmed modules are NOT fetched from the package server.
   */
  shimModules?(): Record<string, string>;

  /**
   * Native packages this plugin shims for web preview that must STILL be declared
   * in package.json for the native build to resolve them. If one is imported but
   * undeclared, the bundle fails (instead of silently shimming it and letting the
   * native build break later).
   */
  nativePackages?(): string[];
}

export type BundlePlatform = "web" | "ios" | "android";

export interface BundlerConfig {
  resolver: ResolverConfig;
  /**
   * Target platform. Undefined behaves exactly like "web" (the historical
   * behavior). Non-web platforms change package-server requests and bundle
   * emission; those paths are threaded in as native support lands.
   */
  platform?: BundlePlatform;
  transformer: Transformer;
  server: {
    packageServerUrl: string;
    /** Custom fetch (e.g. the CLI's disk-cached fetch). Defaults to global fetch. */
    fetch?: typeof fetch;
  };
  hmr?: { enabled: boolean; reactRefresh?: boolean };
  plugins?: BundlerPlugin[];
  env?: Record<string, string>;
  routerShim?: boolean;
  /** URL prefix for external assets, e.g. "/projects/expo-real" */
  assetPublicPath?: string;
  /**
   * Asset metadata by VFS path (dimensions + content hash), supplied by the
   * host that can read asset bytes (the CLI scanner). Used by native
   * (metro-format) builds to emit AssetRegistry registrations -- RN Images
   * lay out at 0x0 without real width/height.
   */
  assetMeta?: Record<string, { width?: number; height?: number; hash: string }>;
  /**
   * Substitute generated JS for a VFS file at build time. Returning a string
   * makes that string the module source (it still flows through the normal
   * transform/require-rewrite pipeline and invalidates caches when it
   * changes); returning undefined keeps default handling. Used by the CLI to
   * turn `.css` imports into nativewind's compiled injectData module on
   * native.
   */
  virtualSource?: (filePath: string) => string | undefined;
  /**
   * Bundle output format. "iife" (default) is the web CJS-registry IIFE;
   * "metro" wraps the bundle in Metro's __d/__r module system for Expo
   * Go / Hermes. Metro output currently disables the web HMR runtime.
   */
  output?: {
    format?: "iife" | "metro";
    /** Module ids required before the entry (e.g. RN's InitializeCore). */
    preRequires?: string[];
    /**
     * Real metro-runtime require.js source (from the package server's
     * /prelude endpoint). When set, metro output uses per-module __d
     * registrations with stable numeric ids (enables native HMR); when
     * absent, the single-__d wrapper fallback is used.
     */
    prelude?: string;
  };
}

export interface FileChange {
  path: string;
  type: "create" | "update" | "delete";
}

export interface ContentChange {
  path: string;
  type: "create" | "update" | "delete";
  content?: string; // omitted for delete
}

export interface HmrUpdate {
  updatedModules: Record<string, string>;
  removedModules: string[];
  requiresReload: boolean;
  reloadReason?: string;
  reverseDepsMap?: Record<string, string[]>;
}

export interface IncrementalBuildResult {
  bundle: string;
  hmrUpdate: HmrUpdate | null;
  type: "full" | "incremental";
  rebuiltModules: string[];
  removedModules: string[];
  buildTime: number;
}
