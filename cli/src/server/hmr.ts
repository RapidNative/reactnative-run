import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { buildMetroHmrBody } from "browser-metro";
import type { BundlerSession, SessionEvent } from "../bundler/session.js";

/**
 * WebSocket hub. Three channels:
 *  - /__hmr    : rnrun's web preview channel (JSON frames the HTML shell bridges
 *                to window.postMessage).
 *  - /hot      : Metro HMR protocol endpoint. Accepted and handshaken now so
 *                Expo Go doesn't error-loop; real update frames land with the
 *                native emit target.
 *  - /message  : Expo's device message channel (reload broadcasts).
 * Unknown upgrade paths are accepted and ignored so Hermes-debugger connection
 * attempts don't error-loop.
 */
export class HmrHub {
  private web = new WebSocketServer({ noServer: true });
  private hot = new WebSocketServer({ noServer: true });
  private message = new WebSocketServer({ noServer: true });
  private misc = new WebSocketServer({ noServer: true });

  private unbind: () => void;
  /** Sink for device console logs arriving on /hot (set by the server). */
  onDeviceLog?: (line: string) => void;

  constructor(private session: BundlerSession) {
    this.unbind = session.onEvent((e) => this.broadcastSessionEvent(e));

    this.web.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "hello", bundleVersion: this.session.bundleVersion }));
      if (this.session.buildError) {
        ws.send(JSON.stringify({ type: "build-error", message: this.session.buildError }));
      }
    });

    this.hot.on("connection", (ws) => {
      ws.on("message", (raw) => {
        let msg: { type?: string; level?: string; data?: unknown[] } = {};
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "register-entrypoints") {
          // Metro handshake: acknowledge, then an initial empty update so
          // HMRClient leaves its "waiting for initial sync" state.
          ws.send(JSON.stringify({ type: "bundle-registered" }));
          const revisionId = `rev-init-${this.revision}`;
          ws.send(JSON.stringify({ type: "update-start", body: { isInitialUpdate: true } }));
          ws.send(JSON.stringify({
            type: "update",
            body: { revisionId, isInitialUpdate: true, added: [], modified: [], deleted: [] },
          }));
          ws.send(JSON.stringify({ type: "update-done" }));
        } else if (msg.type === "log") {
          // RN's HMRClient forwards console.* here in dev.
          const body = (msg.data || [])
            .map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
            .join(" ");
          this.onDeviceLog?.(`[device:${msg.level || "log"}] ${body}`);
        }
      });
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const target =
      pathname === "/__hmr" ? this.web :
      pathname === "/hot" ? this.hot :
      pathname === "/message" ? this.message :
      this.misc;
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  }

  private broadcastSessionEvent(e: SessionEvent): void {
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
      // Expo devices listen on /message for {method:"reload"}.
      this.broadcast(this.message, { version: 2, method: "reload" });
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
   * become /message reload broadcasts. Returns an unsubscribe function.
   */
  attachNativeSession(session: BundlerSession): () => void {
    return session.onEvent((e) => {
      if (e.type === "hmr") {
        const body = buildMetroHmrBody(e.update, session.getModuleIds(), `rev-${++this.revision}`);
        this.broadcast(this.hot, { type: "update-start", body: { isInitialUpdate: false } });
        this.broadcast(this.hot, { type: "update", body });
        this.broadcast(this.hot, { type: "update-done" });
      } else if (e.type === "reload") {
        this.broadcast(this.message, { version: 2, method: "reload" });
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

  clientCount(): number {
    return this.web.clients.size + this.hot.clients.size + this.message.clients.size;
  }

  private broadcast(server: WebSocketServer, payload: unknown): void {
    const body = JSON.stringify(payload);
    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(body);
    }
  }

  close(): void {
    for (const server of [this.web, this.hot, this.message, this.misc]) {
      for (const client of server.clients) client.terminate();
      server.close();
    }
  }
}
