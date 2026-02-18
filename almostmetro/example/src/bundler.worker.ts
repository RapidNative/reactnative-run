import {
  Bundler,
  IncrementalBundler,
  VirtualFS,
  typescriptTransformer,
  reactRefreshTransformer,
} from "almostmetro";
import type { FileMap, BundlerConfig, ContentChange } from "almostmetro";
import { expoWebPlugin } from "./plugins/expo-web";

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

function buildExpoRouterEntry(vfs: VirtualFS): string {
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

  return `import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";
import React from "react";

const modules = {
${moduleMapLines}
};

function ctx(id) { return modules[id]; }
ctx.keys = function() { return Object.keys(modules); };

function App() {
  return React.createElement(ExpoRoot, { context: ctx });
}

registerRootComponent(App);
`;
}

function ensureEntryFile(vfs: VirtualFS): string | null {
  const entry = vfs.getEntryFile();
  if (entry) return entry;

  // If package.json main points to expo-router/entry, generate a synthetic entry
  const main = vfs.getPackageMain();
  if (main === "expo-router/entry") {
    vfs.write("/index.tsx", buildExpoRouterEntry(vfs));
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
    plugins: [expoWebPlugin],
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
    plugins: [expoWebPlugin],
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
