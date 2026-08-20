import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Router, RouteHandler } from "../router.js";
import { sendText } from "../router.js";
import { pageHtml, errorHtml } from "../html.js";
import { mimeFor } from "../../project/assets.js";
import { vfsToDisk } from "../../project/scan.js";
import type { ServerContext } from "../server.js";

// Extensionless dev-server / manifest paths that must NOT be SPA-fallback'd to
// index.html even on a browser navigation. Most are owned by native routes
// registered before these (so they never reach the fallback); /manifest and
// /index.exp are the exceptions -- native matches them only when the request
// "looks Expo" (expo-platform header / ?platform= / multipart Accept), so a
// plain browser text/html GET to them would otherwise fall through here. Kept
// explicit as defense-in-depth so the fallback stays correct regardless of
// route registration order.
const NON_FALLBACK_PATHS = new Set([
  "/manifest",
  "/index.exp",
  "/status",
  "/symbolicate",
  "/logs",
  "/json",
  "/json/list",
  "/json/version",
]);
const NON_FALLBACK_PREFIXES = ["/__bm_assets/", "/assets/", "/_expo/", "/inspector/"];

// Standard expo/Metro web behavior: a browser navigation (Accept: text/html)
// to a deep route like /login must receive the same index.html as /, so the
// client-side expo-router resolves the path -- otherwise a hard refresh or a
// deep link 404s. This is navigation-ONLY: a request without text/html in
// Accept (bare curl, tooling, asset fetches) still 404s, so real misses are
// not masked. Anything with a file extension (/index.bundle, *.map, *.js,
// *.png ...) is an asset, never a navigation, and is excluded.
function isNavigationFallback(url: URL, req: IncomingMessage): boolean {
  if (!(req.headers.accept || "").includes("text/html")) return false;
  const p = url.pathname;
  if (p === "/") return false; // owned by the shell route above
  if (/\.[^/]+$/.test(p)) return false; // has a file extension -> asset, not navigation
  if (NON_FALLBACK_PATHS.has(p)) return false;
  if (NON_FALLBACK_PREFIXES.some((pre) => p.startsWith(pre))) return false;
  return true;
}

export function registerWebRoutes(router: Router, ctx: ServerContext): void {
  const serveShell: RouteHandler = async (_req, res) => {
    const { session } = ctx;
    // First browser hit builds the web bundle if startup skipped it.
    await session.ensureBuilt();
    if (!session.getBundle() && session.buildError) {
      sendText(res, 200, "text/html", errorHtml(ctx.title, session.buildError));
      return;
    }
    sendText(res, 200, "text/html", pageHtml({ title: ctx.title, bundleVersion: session.bundleVersion }));
  };

  // Web preview shell. Only for browsers (Accept: text/html) -- Expo Go's
  // manifest request at the same path is registered BEFORE this and matches
  // on the expo-platform header.
  router.add(
    "GET",
    (url, req) =>
      url.pathname === "/" && (req.headers.accept || "").includes("text/html") ? {} : null,
    serveShell
  );

  // Assets: stream bytes straight from disk (never buffered in memory).
  router.pattern("GET", /^\/__bm_assets\/(?<rest>.+)$/, (_req, res, { params }) => {
    const vfsPath = "/" + decodeURIComponent(params.rest);
    let diskPath: string;
    try {
      diskPath = vfsToDisk(ctx.rootDir, vfsPath);
    } catch {
      sendText(res, 403, "text/plain", "Forbidden");
      return;
    }
    if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
      sendText(res, 404, "text/plain", "Not found: " + vfsPath);
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeFor(vfsPath),
      "Content-Length": fs.statSync(diskPath).size,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(diskPath).pipe(res);
  });

  // SPA deep-path fallback, registered LAST so it only sees paths no asset or
  // route claimed. A browser navigation to a deep expo-router route gets the
  // same index.html as / (200), letting the client router resolve the path.
  router.add("GET", (url, req) => (isNavigationFallback(url, req) ? {} : null), serveShell);
}
