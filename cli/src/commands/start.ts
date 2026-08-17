import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { scanProject } from "../project/scan.js";
import { watchProject } from "../project/watch.js";
import { loadProjectConfig } from "../project/config.js";
import { BundlerSession } from "../bundler/session.js";
import { startServer, getLanIp, type ServerContext } from "../server/server.js";
import { createLogger } from "../ui/logger.js";

export interface StartOptions {
  dir: string;
  port: number;
  packageServer: string;
  localPackages: boolean;
  host: string;
  quiet: boolean;
}

export const DEFAULT_PACKAGE_SERVER = "https://esm.reactnative.run";
export const LOCAL_PACKAGE_SERVER = "http://localhost:5200";

export async function startCommand(options: StartOptions): Promise<void> {
  const log = createLogger(options.quiet);
  const rootDir = path.resolve(options.dir);
  const packageServerUrl = options.localPackages ? LOCAL_PACKAGE_SERVER : options.packageServer;

  let packageServerChild: ChildProcess | null = null;
  if (options.localPackages) {
    packageServerChild = await spawnLocalPackageServer(rootDir, log.info);
  }

  const config = await loadProjectConfig(rootDir, log.warn);
  const title = config.app.name || path.basename(rootDir);

  log.info(`Scanning ${rootDir} ...`);
  const scanStart = performance.now();
  const { files, skippedLarge, assetMeta } = scanProject(rootDir);
  for (const p of skippedLarge) log.warn(`Skipped large file (>2MB): ${p}`);
  log.info(`Scanned ${Object.keys(files).length} files in ${Math.round(performance.now() - scanStart)}ms`);

  let session = new BundlerSession(files, {
    packageServerUrl,
    env: config.env,
    platform: "web",
    assetPublicPath: "/__bm_assets",
  });
  void assetMeta;

  // Native sessions (ios/android) are created lazily on the first bundle
  // request for that platform -- an Expo Go scan shouldn't cost anything until
  // a device actually asks for a bundle.
  const nativeSessions = new Map<string, Promise<BundlerSession>>();
  const makeNativeSession = async (platform: "ios" | "android"): Promise<BundlerSession> => {
    log.info(`Building first ${platform} bundle (Metro format) ...`);
    const rescan = scanProject(rootDir);
    const native = new BundlerSession(rescan.files, {
      packageServerUrl,
      env: config.env,
      platform,
      assetPublicPath: "/__bm_assets",
      metroPrelude: await fetchMetroPrelude(packageServerUrl, config, log.warn),
      assetMeta: rescan.assetMeta,
    });
    native.onEvent((e) => {
      if (e.type === "build-error") log.error(`[${platform}] build error:\n${e.message}`);
      else if (e.type === "hmr") log.info(`[${platform}] Fast Refresh: ${Object.keys(e.update.updatedModules).length} module(s)`);
    });
    // Metro /hot protocol (Fast Refresh) + /message reload fan-out.
    dev.hub.attachNativeSession(native);
    const t = performance.now();
    const ok = await native.build();
    if (ok) {
      log.info(`[${platform}] bundled in ${Math.round(performance.now() - t)}ms (${(native.getBundle().length / 1024).toFixed(0)} KB)`);
    } else {
      log.error(`[${platform}] build failed:\n${native.buildError}`);
    }
    return native;
  };

  const ctx: ServerContext = {
    session,
    config,
    rootDir,
    title,
    port: options.port,
    log: log.info,
    getPlatformSession: async (platform: string) => {
      if (platform !== "ios" && platform !== "android") return null;
      if (!nativeSessions.has(platform)) {
        nativeSessions.set(platform, makeNativeSession(platform));
      }
      return nativeSessions.get(platform)!;
    },
  };

  // Bind the server BEFORE the first build: build errors are served/pushed
  // and the watcher self-heals, instead of the process dying pre-listen.
  const dev = await startServer(ctx, options.host === "localhost" ? "127.0.0.1" : "0.0.0.0");

  const lan = getLanIp();
  log.info("");
  log.info(`  Web:      http://localhost:${dev.port}`);
  log.info(`  Network:  http://${lan}:${dev.port}`);
  log.info(`  Expo Go:  exp://${lan}:${dev.port}`);
  log.info("");

  const buildStart = performance.now();
  const ok = await session.build();
  if (ok) {
    log.info(
      `Bundled in ${Math.round(performance.now() - buildStart)}ms (${(session.getBundle().length / 1024).toFixed(0)} KB)`
    );
  } else {
    log.error(`Build failed:\n${session.buildError}`);
  }

  // Session events → terminal (the HmrHub independently forwards them to clients).
  session.onEvent((e) => {
    if (e.type === "hmr") {
      log.info(`HMR update: ${Object.keys(e.update.updatedModules).length} module(s)`);
    } else if (e.type === "reload") {
      log.info(`Full reload${e.reason ? ` (${e.reason})` : ""}`);
    } else {
      log.error(`Build error:\n${e.message}`);
    }
  });

  const watcher = watchProject({
    rootDir,
    vfsHas: (p) => session.getVfs().exists(p),
    onFlush: async ({ changes, needsReinit, assetChanges }) => {
      if (needsReinit) {
        log.info("Config file changed -- restarting bundler session");
        await reinit();
        return;
      }
      if (assetChanges.length > 0) {
        // Assets stream from disk per request; new assets need VFS entries so
        // requires resolve, then clients reload to pick up fresh bytes.
        let structural = false;
        for (const p of assetChanges) {
          if (!session.getVfs().exists(p)) {
            session.getVfs().write(p, "");
            structural = true;
          }
        }
        if (structural && changes.length === 0) {
          await reinit();
          return;
        }
        if (changes.length === 0) {
          dev.hub.reloadAll();
          return;
        }
      }
      if (changes.length > 0) {
        const t = performance.now();
        await session.applyChanges(changes);
        if (!session.buildError) {
          log.info(`Rebuilt in ${Math.round(performance.now() - t)}ms (${changes.map((c) => c.path).join(", ")})`);
        }
        // Keep any live native sessions in sync (their reload events fan out
        // to devices via /message).
        for (const pending of nativeSessions.values()) {
          const native = await pending;
          await native.applyChanges(changes);
        }
      }
    },
  });

  async function reinit(): Promise<void> {
    const newConfig = await loadProjectConfig(rootDir, log.warn);
    const rescan = scanProject(rootDir);
    const fresh = new BundlerSession(rescan.files, {
      packageServerUrl,
      env: newConfig.env,
      platform: "web",
      assetPublicPath: "/__bm_assets",
    });
    // Swap the session everywhere, rewire hub + terminal logging. Native
    // sessions are dropped and rebuilt lazily on the next device request.
    nativeSessions.clear();
    session = fresh;
    ctx.session = fresh;
    ctx.config = newConfig;
    dev.hub.rebind(fresh);
    fresh.onEvent((e) => {
      if (e.type === "build-error") log.error(`Build error:\n${e.message}`);
    });
    await fresh.build();
    dev.hub.reloadAll();
  }

  // Interactive keys: r = reload all clients, q = quit.
  if (process.stdin.isTTY && !options.quiet) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    log.info("Press r to reload clients, q to quit.");
    process.stdin.on("data", (key: string) => {
      if (key === "r") {
        dev.hub.reloadAll();
        log.info("Reloaded all clients");
      } else if (key === "q" || key === "\u0003") {
        void shutdown();
      }
    });
  }

  const shutdown = async () => {
    log.info("Shutting down ...");
    await watcher.close();
    await dev.close();
    if (packageServerChild) packageServerChild.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/**
 * Fetch the metro-runtime require.js prelude for the project's react-native
 * version. Enables per-module __d output (and with it, native HMR). Absent
 * or failing, the session falls back to the single-__d wrapper -- boots fine,
 * edits are full reloads.
 */
let metroPreludeCache: string | undefined;
async function fetchMetroPrelude(
  packageServerUrl: string,
  config: { pkg: Record<string, unknown> },
  warn: (msg: string) => void
): Promise<string | undefined> {
  if (metroPreludeCache !== undefined) return metroPreludeCache || undefined;
  const deps = (config.pkg?.dependencies || {}) as Record<string, string>;
  const rnVersion = deps["react-native"];
  if (!rnVersion) return undefined;
  try {
    const res = await fetch(
      `${packageServerUrl}/prelude/${encodeURIComponent(rnVersion)}`,
      { signal: AbortSignal.timeout(180_000) }
    );
    if (res.ok) {
      metroPreludeCache = await res.text();
      return metroPreludeCache;
    }
    warn(`metro-runtime prelude unavailable (HTTP ${res.status}); native HMR disabled this session.`);
  } catch (err) {
    warn(`metro-runtime prelude fetch failed (${(err as Error).message}); native HMR disabled this session.`);
  }
  metroPreludeCache = "";
  return undefined;
}

/**
 * --local-packages: spawn reactnative-esm when running inside the monorepo;
 * otherwise instruct the user to point --package-server at a running instance.
 */
async function spawnLocalPackageServer(
  rootDir: string,
  log: (msg: string) => void
): Promise<ChildProcess | null> {
  // Probe: already running?
  try {
    const res = await fetch(`${LOCAL_PACKAGE_SERVER}/bundle-deps/probe`, { signal: AbortSignal.timeout(1000) });
    if (res.status === 404 || res.ok) {
      log(`Package server already running at ${LOCAL_PACKAGE_SERVER}`);
      return null;
    }
  } catch {
    // Not running -- try to spawn from the monorepo layout.
  }

  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // cli/dist/commands -> repo root
  const repoRoot = path.resolve(here, "../../..");
  const serverDir = path.join(repoRoot, "reactnative-esm");
  if (!existsSync(path.join(serverDir, "package.json"))) {
    throw new Error(
      `--local-packages: no local reactnative-esm found. Start one manually and pass --package-server ${LOCAL_PACKAGE_SERVER}`
    );
  }

  log(`Starting local package server (${serverDir}) ...`);
  const child = spawn("npm", ["start"], { cwd: serverDir, stdio: "ignore", detached: false });

  // Wait for readiness (up to 15s).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${LOCAL_PACKAGE_SERVER}/bundle-deps/probe`, { signal: AbortSignal.timeout(500) });
      if (res.status === 404 || res.ok) {
        log("Package server ready");
        return child;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  child.kill("SIGTERM");
  throw new Error("--local-packages: package server did not become ready within 15s");
}
