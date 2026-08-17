import {
  Bundler,
  IncrementalBundler,
  VirtualFS,
  typescriptTransformer,
  reactRefreshTransformer,
  createDataBxPathPlugin,
  isApiRouteFile,
  ensureEntryFile,
  applyRouteStructureChanges,
  buildApiBundle as buildApiBundleLib,
} from "browser-metro";
import type { FileMap, BundlerConfig, ContentChange } from "browser-metro";
import { expoWebPlugin } from "./plugins/expo-web";

const dataBxPathPlugin = createDataBxPathPlugin();

// --- One-shot bundle types (backward compat) ---

interface BundleRequest {
  type?: "bundle";
  files: FileMap;
  packageServerUrl: string;
  projectName?: string;
  assetBaseUrl?: string;
}

// --- Watch mode types ---

interface WatchStartRequest {
  type: "watch-start";
  files: FileMap;
  packageServerUrl: string;
  projectName?: string;
  assetBaseUrl?: string;
}

interface WatchUpdateRequest {
  type: "watch-update";
  changes: ContentChange[];
}

interface WatchStopRequest {
  type: "watch-stop";
}

type WorkerRequest =
  | BundleRequest
  | WatchStartRequest
  | WatchUpdateRequest
  | WatchStopRequest;

// --- API bundle helper ---
// Entry synthesis and API-route logic live in the browser-metro library
// (src/expo/entry.ts); this wrapper just supplies the example's config.

async function buildApiBundle(vfs: VirtualFS, packageServerUrl: string): Promise<string | null> {
  const config: BundlerConfig = {
    resolver: { sourceExts: ["web.ts", "web.tsx", "web.js", "web.jsx", "ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl },
    plugins: [dataBxPathPlugin],
    env: {},
  };
  return await buildApiBundleLib(vfs, config);
}

// --- Watch mode state ---

let incrementalBundler: IncrementalBundler | null = null;
let watchFS: VirtualFS | null = null;
let watchPackageServerUrl: string | null = null;
let lastClientBundle: string = "";

async function handleBundle(data: BundleRequest): Promise<void> {
  const { files, packageServerUrl, projectName, assetBaseUrl } = data;
  const assetBase = assetBaseUrl || packageServerUrl;

  const config: BundlerConfig = {
    resolver: { sourceExts: ["web.ts", "web.tsx", "web.js", "web.jsx", "ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl },
    plugins: [dataBxPathPlugin, expoWebPlugin],
    env: {
      EXPO_PUBLIC_TEST: "hello",
    },
    routerShim: true,
    assetPublicPath: projectName ? assetBase + "projects/" + projectName : undefined,
  };

  try {
    const vfs = new VirtualFS(files);
    const entryFile = ensureEntryFile(vfs);
    const bundler = new Bundler(vfs, config);
    if (!entryFile) {
      self.postMessage({ type: "error", message: "No entry file found" });
      return;
    }
    const code = await bundler.bundle(entryFile);

    let apiBundle: string | null = null;
    try {
      apiBundle = await buildApiBundle(vfs, packageServerUrl);
    } catch (_) {}

    self.postMessage({ type: "result", code, apiBundle });
  } catch (err: unknown) {
    const message = err instanceof Error
      ? err.stack || err.message
      : String(err);
    self.postMessage({ type: "error", message });
  }
}

async function handleWatchStart(data: WatchStartRequest): Promise<void> {
  const { files, packageServerUrl, projectName, assetBaseUrl } = data;
  watchPackageServerUrl = packageServerUrl;
  const assetBase = assetBaseUrl || packageServerUrl;

  const config: BundlerConfig = {
    resolver: { sourceExts: ["web.ts", "web.tsx", "web.js", "web.jsx", "ts", "tsx", "js", "jsx"] },
    transformer: reactRefreshTransformer,
    server: { packageServerUrl },
    hmr: { enabled: true, reactRefresh: true },
    plugins: [dataBxPathPlugin, expoWebPlugin],
    env: {
      EXPO_PUBLIC_TEST: "hello",
    },
    routerShim: true,
    assetPublicPath: projectName ? assetBase + "projects/" + projectName : undefined,
  };

  try {
    watchFS = new VirtualFS(files);
    const entryFile = ensureEntryFile(watchFS);
    incrementalBundler = new IncrementalBundler(watchFS, config);
    if (!entryFile) {
      self.postMessage({ type: "error", message: "No entry file found" });
      return;
    }

    const result = await incrementalBundler.build(entryFile);
    lastClientBundle = result.bundle;

    // Build API bundle separately (if any +api files exist)
    let apiBundle: string | null = null;
    try {
      apiBundle = await buildApiBundle(watchFS, packageServerUrl);
    } catch (apiErr: unknown) {
      const apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      self.postMessage({ type: "error", message: "API bundle error: " + apiMsg });
    }

    self.postMessage({ type: "watch-ready", code: result.bundle, apiBundle });
  } catch (err: unknown) {
    const message = err instanceof Error
      ? err.stack || err.message
      : String(err);
    self.postMessage({ type: "error", message });
  }
}

async function handleWatchUpdate(data: WatchUpdateRequest): Promise<void> {
  if (!incrementalBundler || !watchFS) {
    self.postMessage({ type: "error", message: "Watch mode not started" });
    return;
  }

  try {
    const { changes } = data;

    if (changes.length === 0) {
      return;
    }

    // Apply changes directly to the VirtualFS
    for (const change of changes) {
      if (change.type === "delete") {
        watchFS.delete(change.path);
      } else {
        watchFS.write(change.path, change.content!);
      }
    }

    // If any route files under /app/ were added or removed, regenerate the
    // route context module so the new routes are included in the module map.
    const ctxChange = applyRouteStructureChanges(watchFS, changes);
    if (ctxChange) changes.push(ctxChange);

    // Check if any +api files changed -- rebuild API bundle if so
    const hasApiChange = changes.some((c) => isApiRouteFile(c.path));

    // Filter out +api file changes from the client rebuild
    // (they shouldn't affect the client bundle's incremental rebuild)
    const clientChanges = changes.filter((c) => !isApiRouteFile(c.path));

    // Rebuild client bundle with non-API changes
    incrementalBundler.updateFS(watchFS);
    const fileChanges = clientChanges.map((c) => ({ path: c.path, type: c.type }));

    // Only rebuild client if there are client changes
    let apiBundle: string | null = null;
    if (hasApiChange && watchPackageServerUrl) {
      try {
        apiBundle = await buildApiBundle(watchFS, watchPackageServerUrl);
      } catch (apiErr: unknown) {
        const apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
        self.postMessage({ type: "error", message: "API bundle error: " + apiMsg });
      }
    }

    if (fileChanges.length === 0 && hasApiChange) {
      // Only API files changed -- send API-only update
      self.postMessage({ type: "watch-rebuild", code: lastClientBundle, apiBundle });
      return;
    }

    const result = await incrementalBundler.rebuild(fileChanges);
    lastClientBundle = result.bundle;

    if (result.type === "full" || !result.hmrUpdate || result.hmrUpdate.requiresReload) {
      self.postMessage({ type: "watch-rebuild", code: result.bundle, apiBundle });
    } else {
      // Include full bundle as fallback for hmr-full-reload from iframe
      self.postMessage({ type: "hmr-update", update: result.hmrUpdate, bundle: result.bundle, apiBundle });
    }
  } catch (err: unknown) {
    const message = err instanceof Error
      ? err.stack || err.message
      : String(err);
    self.postMessage({ type: "error", message });
  }
}

function handleWatchStop(): void {
  incrementalBundler = null;
  watchFS = null;
  watchPackageServerUrl = null;
  lastClientBundle = "";
  self.postMessage({ type: "watch-stopped" });
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const data = e.data;
  const messageType = data.type;

  if (!messageType || messageType === "bundle") {
    await handleBundle(data as BundleRequest);
  } else if (messageType === "watch-start") {
    await handleWatchStart(data as WatchStartRequest);
  } else if (messageType === "watch-update") {
    await handleWatchUpdate(data as WatchUpdateRequest);
  } else if (messageType === "watch-stop") {
    handleWatchStop();
  }
};
