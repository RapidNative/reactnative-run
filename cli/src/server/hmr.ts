import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { buildMetroHmrBody } from "browser-metro";
import type { HmrUpdate } from "browser-metro";
import type { BundlerSession, SessionEvent } from "../bundler/session.js";
import { ClientRegistry, clientTokenFromUrl, platformFromUrl } from "./clients.js";

export interface HmrHubOptions {
  /** What each device was served (server/clients.ts). */
  clients?: ClientRegistry;
  /** The native session a platform is currently served from, or null. */
  peekPlatformSession?: (platform: string) => BundlerSession | null;
  log?: (msg: string) => void;
}

/**
 * How long to give a stale device's dev client to connect after its /hot
 * handshake, before falling back to a /message reload broadcast. The two
 * sockets open within milliseconds of each other at JS start; the fallback is
 * for bundles from before the dev client existed, which never connect.
 */
const DEV_CLIENT_GRACE_MS = 3_000;

/**
 * Floor between two reloads of the same device. A reload is loop-free by
 * construction (the re-fetch updates the token's record, so the next check
 * matches), so this only ever fires if something upstream misbehaves -- and
 * then it turns a reload storm into one reload every few seconds plus a log
 * line that says why.
 */
const RELOAD_FLOOR_MS = 5_000;

type Verdict =
  | { kind: "unknown" }
  | { kind: "current" }
  | { kind: "catch-up"; update: HmrUpdate; session: BundlerSession; behind: number }
  | { kind: "reload"; reason: string };

/**
 * WebSocket hub. Four channels:
 *  - /__hmr    : rnrun's web preview channel (JSON frames the HTML shell bridges
 *                to window.postMessage).
 *  - /hot      : Metro HMR protocol endpoint (Fast Refresh on device). The
 *                register-entrypoints handshake carries the device's bundle URL,
 *                whose client token says which bundle it runs -- the initial
 *                update is the catch-up patch for anything it missed, or a
 *                reload when it can't be patched (see clients.ts).
 *  - /message  : Expo's device message channel (reload broadcasts).
 *  - /__rnrun  : rnrun's own per-device channel, opened by the dev client the
 *                native bundle carries. Reconnects when the server restarts,
 *                which RN's HMRClient never does, so a stale device can be
 *                told -- individually -- to reload. Broadcast reloads stay on
 *                /message; this channel only ever addresses one device.
 * Unknown upgrade paths are accepted and ignored so Hermes-debugger connection
 * attempts don't error-loop.
 */
export class HmrHub {
  private web = new WebSocketServer({ noServer: true });
  private hot = new WebSocketServer({ noServer: true });
  private message = new WebSocketServer({ noServer: true });
  private native = new WebSocketServer({ noServer: true });
  private misc = new WebSocketServer({ noServer: true });

  /** Dev-client sockets by client token (a token is one device launch). */
  private devClients = new Map<string, Set<WebSocket>>();
  /** Stale devices whose dev client hasn't shown up yet (token -> fallback timer). */
  private pendingReload = new Map<string, NodeJS.Timeout>();
  /** When each device was last told to reload (RELOAD_FLOOR_MS). */
  private lastReload = new Map<string, number>();

  private unbind: () => void;
  /** Sink for device console logs arriving on /hot (set by the server). */
  onDeviceLog?: (line: string) => void;

  constructor(
    private session: BundlerSession,
    private opts: HmrHubOptions = {}
  ) {
    this.unbind = session.onEvent((e) => this.broadcastSessionEvent(e));

    this.web.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "hello", bundleVersion: this.session.bundleVersion }));
      if (this.session.buildError) {
        ws.send(JSON.stringify({ type: "build-error", message: this.session.buildError }));
      }
    });

    this.hot.on("connection", (ws) => {
      ws.on("message", (raw) => {
        let msg: { type?: string; level?: string; data?: unknown[]; entryPoints?: unknown } = {};
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "register-entrypoints") {
          this.registerHotClient(ws, Array.isArray(msg.entryPoints) ? (msg.entryPoints as unknown[]) : []);
        } else if (msg.type === "log") {
          // RN's HMRClient forwards console.* here in dev.
          const body = (msg.data || [])
            .map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
            .join(" ");
          this.onDeviceLog?.(`[device:${msg.level || "log"}] ${body}`);
        }
      });
    });

    this.native.on("connection", (ws, req: IncomingMessage) => this.onDevClient(ws, req));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const target =
      pathname === "/__hmr" ? this.web :
      pathname === "/hot" ? this.hot :
      pathname === "/message" ? this.message :
      pathname === "/__rnrun" ? this.native :
      this.misc;
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  }

  /**
   * Where a device stands relative to the session it will be patched from.
   * `unknown` = no token (a pre-token URL): nothing to compare, assume fine.
   */
  private assess(token: string | null, platform: string | null): Verdict {
    if (!token) return { kind: "unknown" };
    const served = this.opts.clients?.get(token) ?? null;
    if (!served) return { kind: "reload", reason: "its bundle came from a previous dev server" };
    const session = this.opts.peekPlatformSession?.(platform ?? served.platform) ?? null;
    if (!session || session.epoch !== served.epoch) {
      return { kind: "reload", reason: "its bundle came from a previous bundler session" };
    }
    if (served.version === session.bundleVersion) return { kind: "current" };
    const update = session.catchUp(served.version);
    const behind = session.bundleVersion - served.version;
    if (!update) return { kind: "reload", reason: `it is ${behind} rebuild(s) behind and can't be patched` };
    return { kind: "catch-up", update, session, behind };
  }

  /**
   * Metro handshake. Acknowledge, then send the initial update: empty when the
   * device is current, otherwise every module it missed between fetching its
   * bundle and connecting here (Metro does exactly this from its revision
   * map). RN applies an isInitialUpdate silently -- no "Refreshing…" toast.
   */
  private registerHotClient(ws: WebSocket, entryPoints: unknown[]): void {
    ws.send(JSON.stringify({ type: "bundle-registered" }));
    const entry = typeof entryPoints[0] === "string" ? (entryPoints[0] as string) : null;
    const token = clientTokenFromUrl(entry);
    const platform = platformFromUrl(entry);
    const revisionId = `rev-init-${this.revision}`;
    let body: object = { revisionId, isInitialUpdate: true, added: [], modified: [], deleted: [] };

    const verdict = this.assess(token, platform);
    if (verdict.kind === "catch-up") {
      body = {
        ...buildMetroHmrBody(verdict.update, verdict.session.getModuleIds(), revisionId),
        isInitialUpdate: true,
      };
      this.opts.log?.(
        `[${platform ?? "native"}] device ${token} was ${verdict.behind} rebuild(s) behind -- sent the catch-up patch`
      );
    } else if (verdict.kind === "reload" && token) {
      this.reloadDevice(token, platform, verdict.reason);
    }

    ws.send(JSON.stringify({ type: "update-start", body: { isInitialUpdate: true } }));
    ws.send(JSON.stringify({ type: "update", body }));
    ws.send(JSON.stringify({ type: "update-done" }));
  }

  /** A native bundle's dev client connected (see native-dev-client.ts). */
  private onDevClient(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "/", "http://localhost");
    const token = url.searchParams.get("token");
    const platform = url.searchParams.get("platform");
    if (!token) {
      ws.close();
      return;
    }
    let set = this.devClients.get(token);
    if (!set) {
      set = new Set();
      this.devClients.set(token, set);
    }
    set.add(ws);
    ws.on("close", () => {
      set!.delete(ws);
      if (set!.size === 0) this.devClients.delete(token);
    });

    const pending = this.pendingReload.get(token);
    if (pending) {
      clearTimeout(pending);
      this.pendingReload.delete(token);
    }
    const verdict = this.assess(token, platform);
    if (pending || verdict.kind === "reload") {
      const reason = verdict.kind === "reload" ? verdict.reason : "it missed patches it can't be caught up on";
      if (this.mayReload(token, platform, reason)) {
        ws.send(JSON.stringify({ type: "reload", reason }));
        return;
      }
    }
    ws.send(JSON.stringify({ type: "hello" }));
  }

  private mayReload(token: string, platform: string | null, reason: string): boolean {
    const last = this.lastReload.get(token) ?? 0;
    const now = Date.now();
    if (now - last < RELOAD_FLOOR_MS) {
      this.opts.log?.(`[${platform ?? "native"}] NOT reloading device ${token} again within ${RELOAD_FLOOR_MS}ms (${reason})`);
      return false;
    }
    this.lastReload.set(token, now);
    if (this.lastReload.size > 512) {
      const oldest = this.lastReload.keys().next().value;
      if (oldest !== undefined) this.lastReload.delete(oldest);
    }
    this.opts.log?.(`[${platform ?? "native"}] reloading device ${token}: ${reason}`);
    return true;
  }

  /**
   * Reload one device: through its dev client when connected; otherwise wait
   * briefly for that socket (it opens moments after /hot at JS start) and fall
   * back to a /message broadcast, which every device honours.
   */
  private reloadDevice(token: string, platform: string | null, reason: string): void {
    const sockets = this.devClients.get(token);
    if (sockets && sockets.size > 0) {
      if (!this.mayReload(token, platform, reason)) return;
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reload", reason }));
      }
      return;
    }
    if (this.pendingReload.has(token)) return;
    this.pendingReload.set(
      token,
      setTimeout(() => {
        this.pendingReload.delete(token);
        this.opts.log?.(
          `[${platform ?? "native"}] reloading every device (no dev client for ${token}): ${reason}`
        );
        this.broadcast(this.message, { version: 2, method: "reload" });
      }, DEV_CLIENT_GRACE_MS)
    );
  }

  private broadcastSessionEvent(e: SessionEvent): void {
    // The WEB session's events. Its reloads stay on the web channel: they used
    // to go to /message as well, which reloaded every phone whenever the web
    // bundle did a full rebuild (e.g. its lazy first build after a wake) --
    // native reloads come from attachNativeSession.
    if (e.type === "hmr") {
      this.broadcast(this.web, {
        type: "hmr-update",
        updatedModules: e.update.updatedModules,
        removedModules: e.update.removedModules,
        reverseDepsMap: e.update.reverseDepsMap,
        bundleVersion: e.bundleVersion,
      });
    } else if (e.type === "reload") {
      this.broadcast(this.web, { type: "reload", bundleVersion: e.bundleVersion });
    } else if (e.type === "build-error") {
      this.broadcast(this.web, { type: "build-error", message: e.message });
    }
  }

  /** Swap to a fresh session (config-change re-init) and keep broadcasting. */
  rebind(session: BundlerSession): void {
    this.unbind();
    this.session = session;
    this.unbind = session.onEvent((e) => this.broadcastSessionEvent(e));
  }

  private revision = 0;

  /**
   * Attach a NATIVE (metro-format) session: its hmr events become Metro
   * protocol frames on /hot (Fast Refresh on device); requiresReload events
   * become /message reload broadcasts. Returns
   * an unsubscribe function -- call it when the session is dropped, or a
   * stale session keeps a listener alive.
   */
  attachNativeSession(session: BundlerSession): () => void {
    return session.onEvent((e) => {
      if (e.type === "hmr") {
        const body = buildMetroHmrBody(e.update, session.getModuleIds(), `rev-${++this.revision}`);
        this.broadcast(this.hot, { type: "update-start", body: { isInitialUpdate: false } });
        this.broadcast(this.hot, { type: "update", body });
        this.broadcast(this.hot, { type: "update-done" });
      } else if (e.type === "reload") {
        // /message reaches every device (Expo Go honours it natively); the
        // dev-client channel is for TARGETED reloads, and sending both would
        // reload each device twice.
        this.broadcast(this.message, { version: 2, method: "reload" });
      } else if (e.type === "build-error") {
        // Metro parity: a rebuild failure surfaces as a LogBox error on the
        // device instead of silently keeping stale code running.
        this.broadcast(this.hot, {
          type: "error",
          body: { type: "TransformError", message: e.message, errors: [] },
        });
      }
    });
  }

  /** DEBUG: inject a raw code string through the Metro /hot protocol. */
  debugInjectHot(code: string): number {
    const body = {
      revisionId: `dbg-${++this.revision}`,
      isInitialUpdate: false,
      added: [],
      modified: [
        { module: [999999, code] as [number, string], sourceMappingURL: null, sourceURL: "debug" },
      ],
      deleted: [],
    };
    this.broadcast(this.hot, { type: "update-start", body: { isInitialUpdate: false } });
    this.broadcast(this.hot, { type: "update", body });
    this.broadcast(this.hot, { type: "update-done" });
    return this.hot.clients.size;
  }

  /** Ask every connected client (web + native) to reload. */
  reloadAll(): void {
    this.broadcast(this.web, { type: "reload", bundleVersion: this.session.bundleVersion });
    this.broadcast(this.message, { version: 2, method: "reload" });
  }

  /** Toggle the in-app developer menu on connected Expo Go clients. */
  devMenuAll(): void {
    this.broadcast(this.message, { version: 2, method: "devMenu" });
  }

  clientCount(): number {
    return this.web.clients.size + this.hot.clients.size + this.message.clients.size + this.native.clients.size;
  }

  private broadcast(server: WebSocketServer, payload: unknown): void {
    const body = JSON.stringify(payload);
    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(body);
    }
  }

  close(): void {
    for (const timer of this.pendingReload.values()) clearTimeout(timer);
    this.pendingReload.clear();
    for (const server of [this.web, this.hot, this.message, this.native, this.misc]) {
      for (const client of server.clients) client.terminate();
      server.close();
    }
  }
}
