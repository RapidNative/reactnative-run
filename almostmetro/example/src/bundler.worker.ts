import {
  Bundler,
  IncrementalBundler,
  VirtualFS,
  typescriptTransformer,
  reactRefreshTransformer,
} from "almostmetro";
import type { FileMap, BundlerConfig, ContentChange } from "almostmetro";
import { webPlugin } from "./plugins/web-plugin";
import { expoPlugin } from "./plugins/expo-plugin";

// --- One-shot bundle types ---

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

// --- Target config builder ---

interface TargetConfig {
  name: string;
  config: BundlerConfig;
}

function buildTargetConfigs(packageServerUrl: string, opts?: { hmr?: boolean }): TargetConfig[] {
  return [
    {
      name: "web",
      config: {
        resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
        transformer: opts?.hmr ? reactRefreshTransformer : typescriptTransformer,
        server: { packageServerUrl, platform: "browser" },
        hmr: opts?.hmr ? { enabled: true, reactRefresh: true } : undefined,
        plugins: [webPlugin],
      },
    },
    {
      name: "expo",
      config: {
        resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
        transformer: typescriptTransformer,
        server: { packageServerUrl, platform: "native" },
        plugins: [expoPlugin],
      },
    },
  ];
}

// --- Watch mode state ---

let incrementalBundlers: Map<string, IncrementalBundler> | null = null;
let watchFS: VirtualFS | null = null;

async function handleBundle(data: BundleRequest): Promise<void> {
  const { files, packageServerUrl } = data;
  const targets = buildTargetConfigs(packageServerUrl);

  try {
    const vfs = new VirtualFS(files);
    const entryFile = vfs.getEntryFile();
    if (!entryFile) {
      self.postMessage({ type: "error", message: "No entry file found" });
      return;
    }

    const results = await Promise.all(
      targets.map(async (t) => {
        const bundler = new Bundler(vfs, t.config);
        const bundle = await bundler.bundle(entryFile);
        return { name: t.name, bundle };
      }),
    );

    const bundles: Record<string, string> = {};
    for (const r of results) {
      bundles[r.name] = r.bundle;
    }

    self.postMessage({ type: "result", bundles });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message });
  }
}

async function handleWatchStart(data: WatchStartRequest): Promise<void> {
  const { files, packageServerUrl } = data;
  const targets = buildTargetConfigs(packageServerUrl, { hmr: true });

  try {
    watchFS = new VirtualFS(files);
    const entryFile = watchFS.getEntryFile();
    if (!entryFile) {
      self.postMessage({ type: "error", message: "No entry file found" });
      return;
    }

    incrementalBundlers = new Map();
    const results = await Promise.all(
      targets.map(async (t) => {
        const bundler = new IncrementalBundler(watchFS!, t.config);
        incrementalBundlers!.set(t.name, bundler);
        const result = await bundler.build(entryFile);
        return { name: t.name, result };
      }),
    );

    const bundles: Record<string, string> = {};
    for (const r of results) {
      bundles[r.name] = r.result.bundle;
    }

    self.postMessage({ type: "watch-ready", bundles });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message });
  }
}

async function handleWatchUpdate(data: WatchUpdateRequest): Promise<void> {
  if (!incrementalBundlers || !watchFS) {
    self.postMessage({ type: "error", message: "Watch mode not started" });
    return;
  }

  try {
    const { changes } = data;

    if (changes.length === 0) {
      return;
    }

    // Apply changes to the shared VirtualFS once
    for (const change of changes) {
      if (change.type === "delete") {
        watchFS.delete(change.path);
      } else {
        watchFS.write(change.path, change.content!);
      }
    }

    const fileChanges = changes.map((c) => ({ path: c.path, type: c.type }));

    // Rebuild all targets in parallel
    const results = await Promise.all(
      Array.from(incrementalBundlers.entries()).map(async ([name, bundler]) => {
        bundler.updateFS(watchFS!);
        const result = await bundler.rebuild(fileChanges);
        return { name, result };
      }),
    );

    const bundles: Record<string, string> = {};
    for (const r of results) {
      bundles[r.name] = r.result.bundle;
    }

    // Find the target with HMR enabled (web)
    const hmrResult = results.find(
      (r) => r.result.hmrUpdate !== null,
    );

    if (!hmrResult || hmrResult.result.type === "full" || hmrResult.result.hmrUpdate?.requiresReload) {
      self.postMessage({ type: "watch-rebuild", bundles });
    } else {
      self.postMessage({
        type: "hmr-update",
        update: hmrResult.result.hmrUpdate,
        bundles,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message });
  }
}

function handleWatchStop(): void {
  incrementalBundlers = null;
  watchFS = null;
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
