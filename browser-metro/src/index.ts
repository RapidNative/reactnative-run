export { Bundler } from "./bundler.js";
export { IncrementalBundler } from "./incremental-bundler.js";
export { VirtualFS } from "./fs.js";
export { Resolver, platformSourceExts } from "./resolver.js";
export { DependencyGraph } from "./dependency-graph.js";
export { ModuleCache } from "./module-cache.js";
export { typescriptTransformer } from "./transforms/typescript.js";
export {
  reactRefreshTransformer,
  metroReactRefreshTransformer,
  createReactRefreshTransformer,
} from "./transforms/react-refresh.js";
export type { RawSourceMap } from "./source-map.js";
export { createDataBxPathPlugin } from "./plugins/data-bx-path.js";
export { createExpoWebShimsPlugin } from "./plugins/expo-web-shims.js";
export {
  createUnsupportedWebPackagesPlugin,
  UNSUPPORTED_WEB_PACKAGES,
} from "./plugins/unsupported-web-packages.js";
export type { UnsupportedPackageEntry } from "./plugins/unsupported-web-packages.js";
export { emitMetroWrappedBundle, emitMetroModulesBundle, emitMetroModule, buildMetroPrelude, buildMetroHmrBody } from "./metro-emit.js";
export { ModuleIdRegistry } from "./module-ids.js";
export type { MetroEmitOptions, MetroHmrBody, MetroHmrModuleEntry, BundleLineIndexEntry } from "./metro-emit.js";
export { INITIALIZE_CORE_SUBPATH, NATIVE_POLYFILL_SUBPATHS } from "./utils.js";
export {
  isApiRouteFile,
  filePathToApiRoute,
  buildApiRoutesEntry,
  buildExpoRouteContext,
  buildExpoRouterEntry,
  ensureEntryFile,
  applyRouteStructureChanges,
  buildApiBundle,
} from "./expo/entry.js";
export type {
  BundlePlatform,
  FileEntry,
  FileMap,
  ModuleMap,
  TransformResult,
  TransformParams,
  Transformer,
  ResolverConfig,
  BundlerPlugin,
  BundlerConfig,
  FileChange,
  ContentChange,
  HmrUpdate,
  IncrementalBuildResult,
} from "./types.js";
