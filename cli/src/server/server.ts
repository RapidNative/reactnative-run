import * as http from "node:http";
import * as os from "node:os";
import { Router, sendText } from "./router.js";
import { registerNativeRoutes } from "./routes/native.js";
import { registerWebRoutes } from "./routes/web.js";
import { HmrHub } from "./hmr.js";
import { ClientRegistry } from "./clients.js";
import type { BundlerSession } from "../bundler/session.js";
import type { ProjectConfig } from "../project/config.js";

export interface ServerContext {
  session: BundlerSession;
  config: ProjectConfig;
  rootDir: string;
  title: string;
  port: number;
  log: (msg: string) => void;
  /**
   * Lazily create/reuse a bundler session for a native platform ("ios" |
   * "android"). Returns null when native serving isn't wired (bundle route
   * then answers 501). Provided by the start command.
   */
  getPlatformSession?: (platform: string) => Promise<BundlerSession | null>;
  /** Why a platform's session could not be built, surfaced to the device as a
   *  redbox instead of failing silently or taking the server down. */
  getPlatformError?: (platform: string) => string | null;
  /**
   * The native session a platform is currently served from, WITHOUT creating
   * one (null when none exists yet, e.g. right after boot or a re-init). What
   * the ws hub compares a device's recorded bundle against.
   */
  peekPlatformSession?: (platform: string) => BundlerSession | null;
  /** What each device was served (created by startServer when absent). */
  clients?: ClientRegistry;
  /** Set by startServer once the ws hub exists. */
  hub?: HmrHub;
}

export interface DevServer {
  server: http.Server;
  hub: HmrHub;
  port: number;
  close(): Promise<void>;
}

export async function startServer(ctx: ServerContext, host = "0.0.0.0"): Promise<DevServer> {
  const router = new Router();
  // Order matters: the manifest route claims "/" for Expo Go requests before
  // the web shell claims it for browsers.
  registerNativeRoutes(router, ctx);
  registerWebRoutes(router, ctx);

  ctx.clients ??= new ClientRegistry();
  const hub = new HmrHub(ctx.session, {
    clients: ctx.clients,
    peekPlatformSession: (platform) => ctx.peekPlatformSession?.(platform) ?? null,
    log: ctx.log,
  });
  hub.onDeviceLog = (line) => ctx.log(line);
  ctx.hub = hub;

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await router.dispatch(req, res);
      if (!handled) sendText(res, 404, "text/plain", "Not found: " + req.url);
    } catch (err) {
      ctx.log(`[server] error handling ${req.url}: ${(err as Error).stack || err}`);
      if (!res.headersSent) sendText(res, 500, "text/plain", "Internal error");
      else res.end();
    }
  });

  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ctx.port, host, () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;
  ctx.port = actualPort;

  return {
    server,
    hub,
    port: actualPort,
    close: async () => {
      hub.close();
      // Browsers hold keep-alive sockets open; without this, close() waits
      // for them indefinitely and Ctrl+C appears to hang.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function getLanIp(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}
