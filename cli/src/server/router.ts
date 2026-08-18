import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
) => void | Promise<void>;

interface Route {
  method: string;
  match: (url: URL, req: IncomingMessage) => Record<string, string> | null;
  handler: RouteHandler;
}

/**
 * Minimal ordered router over node:http. Routes are tried in registration
 * order; the first match wins. `match` gets the full request so routes can
 * negotiate on headers (the Expo Go manifest route matches on `expo-platform`
 * at the same path a browser gets HTML from).
 */
export class Router {
  private routes: Route[] = [];

  add(method: string, match: Route["match"], handler: RouteHandler): void {
    this.routes.push({ method, match, handler });
  }

  /** Convenience: exact-path match. */
  path(method: string, pathname: string, handler: RouteHandler): void {
    this.add(method, (url) => (url.pathname === pathname ? {} : null), handler);
  }

  /** Convenience: regex path match; named groups become params. */
  pattern(method: string, re: RegExp, handler: RouteHandler): void {
    this.add(method, (url) => {
      const m = url.pathname.match(re);
      return m ? { ...(m.groups || {}) } : null;
    }, handler);
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    for (const route of this.routes) {
      if (route.method !== req.method && route.method !== "*") continue;
      const params = route.match(url, req);
      if (!params) continue;
      await route.handler(req, res, { url, params });
      return true;
    }
    return false;
  }
}

export function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    // Explicit length rather than chunked: clients that show download
    // progress (Expo Go's loading screen, browser devtools) need a total.
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendText(res, status, "application/json", JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
