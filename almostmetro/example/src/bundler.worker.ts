import {
  Bundler,
  IncrementalBundler,
  VirtualFS,
  typescriptTransformer,
  reactRefreshTransformer,
  createDataBxPathPlugin,
} from "almostmetro";
import type { FileMap, BundlerConfig, ContentChange } from "almostmetro";
import { expoWebPlugin } from "./plugins/expo-web";

const dataBxPathPlugin = createDataBxPathPlugin();

// --- One-shot bundle types (backward compat) ---

interface BundleRequest {
  type?: "bundle";
  files: FileMap;
  packageServerUrl: string;
  projectName?: string;
}

// --- Watch mode types ---

interface WatchStartRequest {
  type: "watch-start";
  files: FileMap;
  packageServerUrl: string;
  projectName?: string;
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

// --- Expo Router synthetic entry ---

/**
 * Check if a file path is an API route (+api.ts/tsx/js/jsx).
 */
function isApiRouteFile(filePath: string): boolean {
  return /\+api\.(ts|tsx|js|jsx)$/.test(filePath);
}

/**
 * Convert a file path like /app/api/hello+api.ts to a URL like /api/hello.
 * Supports dynamic segments: /app/api/users/[id]+api.ts -> /api/users/[id]
 * Supports index routes: /app/api/index+api.ts -> /api
 */
function filePathToApiRoute(filePath: string): string {
  // Strip /app prefix and extension
  let route = filePath.slice("/app".length).replace(/\+api\.(tsx?|jsx?|js)$/, "");
  // Remove trailing slash
  if (route.endsWith("/")) route = route.slice(0, -1);
  // Handle index routes
  if (route.endsWith("/index")) route = route.slice(0, -"/index".length);
  return route || "/";
}

/**
 * Build the API routes entry module that maps URL paths to their handler modules.
 * Exports routes object and a match() function for URL matching.
 */
function buildApiRoutesEntry(vfs: VirtualFS): string | null {
  const routeExts = new Set(["tsx", "ts", "jsx", "js"]);
  const apiFiles: { filePath: string; urlPath: string }[] = [];

  for (const filePath of vfs.list()) {
    if (!filePath.startsWith("/app/")) continue;
    if (!isApiRouteFile(filePath)) continue;
    const ext = filePath.split(".").pop() || "";
    if (!routeExts.has(ext)) continue;
    apiFiles.push({
      filePath,
      urlPath: filePathToApiRoute(filePath),
    });
  }

  if (apiFiles.length === 0) return null;

  const routeEntries = apiFiles
    .map((r) => {
      const requirePath = "." + r.filePath.replace(/\.[^.]+$/, "");
      return `  "${r.urlPath}": require("${requirePath}"),`;
    })
    .join("\n");

  return `var routes = {
${routeEntries}
};

function match(pathname) {
  // Exact match first
  if (routes[pathname]) return { handler: routes[pathname], params: {} };
  // Dynamic segment matching
  var keys = Object.keys(routes);
  for (var i = 0; i < keys.length; i++) {
    var pattern = keys[i];
    if (pattern.indexOf("[") === -1) continue;
    var patternParts = pattern.split("/");
    var pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) continue;
    var params = {};
    var matched = true;
    for (var j = 0; j < patternParts.length; j++) {
      if (patternParts[j].startsWith("[") && patternParts[j].endsWith("]")) {
        params[patternParts[j].slice(1, -1)] = pathParts[j];
      } else if (patternParts[j] !== pathParts[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: routes[pattern], params: params };
  }
  return null;
}

// Expose on window so the fetch interceptor can access it
if (typeof window !== "undefined") {
  window.__API_ROUTES__ = { routes: routes, match: match };
}
module.exports = { routes: routes, match: match };
`;
}

function buildExpoRouteContext(vfs: VirtualFS): string {
  const routeExts = new Set(["tsx", "ts", "jsx", "js"]);
  const routeFiles: string[] = [];

  for (const filePath of vfs.list()) {
    if (!filePath.startsWith("/app/")) continue;
    const ext = filePath.split(".").pop() || "";
    if (!routeExts.has(ext)) continue;
    // Exclude API route files from the client route context
    if (isApiRouteFile(filePath)) continue;
    routeFiles.push(filePath);
  }

  // Build module map entries: context key -> require path
  // Context keys are relative to /app/ with "./" prefix, e.g. "./(tabs)/index.tsx"
  // Require paths are relative to project root with "./" prefix, e.g. "./app/(tabs)/index"
  const moduleEntries = routeFiles.map((filePath) => {
    const contextKey = "./" + filePath.slice("/app/".length);
    const requirePath = "." + filePath.replace(/\.[^.]+$/, "");
    return { contextKey, requirePath };
  });

  const moduleMapLines = moduleEntries
    .map((e) => `  "${e.contextKey}": require("${e.requirePath}"),`)
    .join("\n");

  return `var modules = {
${moduleMapLines}
};
function ctx(id) { return modules[id]; }
ctx.keys = function() { return Object.keys(modules); };

module.exports = ctx;
`;
}

/**
 * Build the synthetic entry that imports the route context and renders ExpoRoot.
 * This is a .tsx file so React Refresh instruments App with module.hot.accept(),
 * making it an HMR accept boundary for route context changes.
 */
function buildExpoRouterEntry(): string {
  return `import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";
import React from "react";

const ctx = require("./__expo_ctx");

function App() {
  return React.createElement(ExpoRoot, { context: ctx });
}

if (!window.__EXPO_ROOT_REGISTERED) {
  registerRootComponent(App);
  window.__EXPO_ROOT_REGISTERED = true;
}
`;
}

function ensureEntryFile(vfs: VirtualFS): string | null {
  const entry = vfs.getEntryFile();
  if (entry) return entry;

  // If package.json main points to expo-router/entry, generate a synthetic entry
  const main = vfs.getPackageMain();
  if (main === "expo-router/entry") {
    vfs.write("/__expo_ctx.js", buildExpoRouteContext(vfs));
    vfs.write("/index.tsx", buildExpoRouterEntry());
    return "/index.tsx";
  }

  return null;
}

// --- API bundle helper ---

async function buildApiBundle(vfs: VirtualFS, packageServerUrl: string): Promise<string | null> {
  const apiEntry = buildApiRoutesEntry(vfs);
  if (!apiEntry) return null;

  vfs.write("/__api_routes.js", apiEntry);

  const config: BundlerConfig = {
    resolver: { sourceExts: ["web.ts", "web.tsx", "web.js", "web.jsx", "ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl },
    plugins: [dataBxPathPlugin],
    env: {},
  };

  const bundler = new Bundler(vfs, config);
  return await bundler.bundle("/__api_routes.js");
}

// --- Watch mode state ---

let incrementalBundler: IncrementalBundler | null = null;
let watchFS: VirtualFS | null = null;
let watchPackageServerUrl: string | null = null;
let lastClientBundle: string = "";

async function handleBundle(data: BundleRequest): Promise<void> {
  const { files, packageServerUrl, projectName } = data;

  const config: BundlerConfig = {
    resolver: { sourceExts: ["web.ts", "web.tsx", "web.js", "web.jsx", "ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl },
    plugins: [dataBxPathPlugin, expoWebPlugin],
    env: {
      EXPO_PUBLIC_TEST: "hello",
    },
    routerShim: true,
    assetPublicPath: projectName ? packageServerUrl + "/projects/" + projectName : undefined,
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
  const { files, packageServerUrl, projectName } = data;
  watchPackageServerUrl = packageServerUrl;

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
    assetPublicPath: projectName ? packageServerUrl + "/projects/" + projectName : undefined,
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
    // We regenerate /__expo_ctx.js (not the entry) so HMR can propagate the
    // change up to the entry's App component without requiring a full reload.
    const main = watchFS.getPackageMain();
    if (main === "expo-router/entry") {
      const routeExts = new Set(["tsx", "ts", "jsx", "js"]);
      const hasRouteChange = changes.some((c) => {
        if (!c.path.startsWith("/app/")) return false;
        if (isApiRouteFile(c.path)) return false;
        const ext = c.path.split(".").pop() || "";
        if (!routeExts.has(ext)) return false;
        return c.type === "create" || c.type === "delete";
      });
      if (hasRouteChange) {
        const newCtx = buildExpoRouteContext(watchFS);
        watchFS.write("/__expo_ctx.js", newCtx);
        changes.push({ path: "/__expo_ctx.js", type: "update", content: newCtx });
      }
    }

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
