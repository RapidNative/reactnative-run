import * as fs from "node:fs";
import type { Router } from "../router.js";
import { sendText } from "../router.js";
import { pageHtml, errorHtml } from "../html.js";
import { mimeFor } from "../../project/assets.js";
import { vfsToDisk } from "../../project/scan.js";
import type { ServerContext } from "../server.js";

export function registerWebRoutes(router: Router, ctx: ServerContext): void {
  // Web preview shell. Only for browsers (Accept: text/html) -- Expo Go's
  // manifest request at the same path is registered BEFORE this and matches
  // on the expo-platform header.
  router.add(
    "GET",
    (url, req) =>
      url.pathname === "/" && (req.headers.accept || "").includes("text/html") ? {} : null,
    (_req, res) => {
      const { session } = ctx;
      if (!session.getBundle() && session.buildError) {
        sendText(res, 200, "text/html", errorHtml(ctx.title, session.buildError));
        return;
      }
      sendText(res, 200, "text/html", pageHtml({ title: ctx.title, bundleVersion: session.bundleVersion }));
    }
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
}
