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
}

export interface BundlerConfig {
  resolver: ResolverConfig;
  transformer: Transformer;
  server: { packageServerUrl: string };
  hmr?: { enabled: boolean; reactRefresh?: boolean };
  plugins?: BundlerPlugin[];
  env?: Record<string, string>;
  routerShim?: boolean;
  /** URL prefix for external assets, e.g. "/projects/expo-real" */
  assetPublicPath?: string;
  /** Packages to exclude from bundling (resolved by the host runtime instead) */
  externals?: string[];
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
