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

// --- Watch mode state ---

let incrementalBundler: IncrementalBundler | null = null;
let watchFS: VirtualFS | null = null;
let watchPackageServerUrl: string | null = null;

async function handleBundle(data: BundleRequest): Promise<void> {
  const { files, packageServerUrl } = data;

  const config: BundlerConfig = {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl },
    plugins: [expoWebPlugin],
  };

  try {
    const vfs = new VirtualFS(files);
    const bundler = new Bundler(vfs, config);
    const entryFile = vfs.getEntryFile();
    if (!entryFile) {
      self.postMessage({ type: "error", message: "No entry file found" });
      return;
    }
    const code = await bundler.bundle(entryFile);
    self.postMessage({ type: "result", code });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message });
  }
}

async function handleWatchStart(data: WatchStartRequest): Promise<void> {
  const { files, packageServerUrl } = data;
  watchPackageServerUrl = packageServerUrl;

  const config: BundlerConfig = {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: reactRefreshTransformer,
    server: { packageServerUrl },
    hmr: { enabled: true, reactRefresh: true },
    plugins: [expoWebPlugin],
  };

  try {
    watchFS = new VirtualFS(files);
    incrementalBundler = new IncrementalBundler(watchFS, config);

    const entryFile = watchFS.getEntryFile();
    if (!entryFile) {
      self.postMessage({ type: "error", message: "No entry file found" });
      return;
    }

    const result = await incrementalBundler.build(entryFile);
    self.postMessage({ type: "watch-ready", code: result.bundle });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
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
    const message = err instanceof Error ? err.message : String(err);
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
