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
}

// --- Watch mode types ---

interface WatchStartRequest {
  type: "watch-start";
  files: FileMap;
  packageServerUrl: string;
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
 * Build the route context module that maps route files to their require paths.
 * This is a plain .js file so React Refresh does NOT add module.hot.accept(),
 * allowing HMR updates to bubble up to the entry's App component.
 */
function buildExpoRouteContext(vfs: VirtualFS): string {
  const routeExts = new Set(["tsx", "ts", "jsx", "js"]);
  const routeFiles: string[] = [];

  for (const filePath of vfs.list()) {
    if (!filePath.startsWith("/app/")) continue;
    const ext = filePath.split(".").pop() || "";
    if (!routeExts.has(ext)) continue;
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

// --- Watch mode state ---

let incrementalBundler: IncrementalBundler | null = null;
let watchFS: VirtualFS | null = null;
let watchPackageServerUrl: string | null = null;

async function handleBundle(data: BundleRequest): Promise<void> {
  const { files, packageServerUrl } = data;

  const config: BundlerConfig = {
    resolver: { sourceExts: ["web.ts", "web.tsx", "web.js", "web.jsx", "ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl },
    plugins: [dataBxPathPlugin, expoWebPlugin],
    env: {
      EXPO_PUBLIC_TEST: "hello",
    },
    routerShim: true,
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
    self.postMessage({ type: "result", code });
  } catch (err: unknown) {
    const message = err instanceof Error
      ? err.stack || err.message
      : String(err);
    self.postMessage({ type: "error", message });
  }
}

async function handleWatchStart(data: WatchStartRequest): Promise<void> {
  const { files, packageServerUrl } = data;
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
    self.postMessage({ type: "watch-ready", code: result.bundle });
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

    // Rebuild with the FileChange-compatible list
    incrementalBundler.updateFS(watchFS);
    const fileChanges = changes.map((c) => ({ path: c.path, type: c.type }));
    const result = await incrementalBundler.rebuild(fileChanges);

    if (result.type === "full" || !result.hmrUpdate || result.hmrUpdate.requiresReload) {
      self.postMessage({ type: "watch-rebuild", code: result.bundle });
    } else {
      // Include full bundle as fallback for hmr-full-reload from iframe
      self.postMessage({ type: "hmr-update", update: result.hmrUpdate, bundle: result.bundle });
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
