import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mimeFor } from "../../project/assets.js";
import { vfsToDisk } from "../../project/scan.js";
import type { Router } from "../router.js";
import { sendText, sendJson } from "../router.js";
import type { ServerContext } from "../server.js";

/**
 * Metro/Expo-compatible endpoint surface. The bundle route serves web today
 * and returns 501 for android/ios until the Metro emit target lands; the
 * manifest, /status, /symbolicate and /logs contracts are mounted from day 1
 * so Expo Go can complete its handshake and the native effort has a pinned
 * contract to build against.
 */
export function registerNativeRoutes(router: Router, ctx: ServerContext): void {
  // --- Manifest (expo-updates protocol 0, unsigned) ---
  // Matches / , /manifest, /index.exp when the request looks like Expo Go:
  // expo-platform header, ?platform=, or Accept: multipart/mixed.
  router.add(
    "GET",
    (url, req) => {
      if (!["/", "/manifest", "/index.exp"].includes(url.pathname)) return null;
      const looksExpo =
        !!req.headers["expo-platform"] ||
        !!url.searchParams.get("platform") ||
        (req.headers.accept || "").includes("multipart/mixed") ||
        (req.headers.accept || "").includes("application/expo+json");
      return looksExpo ? {} : null;
    },
    (req, res, { url }) => {
      const platform = String(req.headers["expo-platform"] || url.searchParams.get("platform") || "ios");
      const host = req.headers.host || `localhost:${ctx.port}`;
      const manifest = buildManifest(ctx, platform, host);
      const accept = req.headers.accept || "";

      if (accept.includes("multipart/mixed")) {
        const manifestJson = JSON.stringify(manifest);
        const boundary = "formdata-" + randomUUID().replace(/-/g, "").slice(0, 16);
        const body =
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="manifest"\r\n` +
          `Content-Type: application/json\r\n\r\n` +
          manifestJson +
          `\r\n--${boundary}--\r\n`;
        res.writeHead(200, {
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
          "expo-protocol-version": "0",
          "expo-sfv-version": "0",
          "cache-control": "private, max-age=0",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "expo-protocol-version": "0",
          "expo-sfv-version": "0",
          "cache-control": "private, max-age=0",
        });
        res.end(JSON.stringify(manifest));
      }
    }
  );

  // --- Bundle (any path ending in .bundle; platform via query) ---
  router.pattern("GET", /\.bundle$/, async (_req, res, { url }) => {
    const platform = url.searchParams.get("platform") || "web";
    let session = ctx.session;
    if (platform !== "web") {
      const native = ctx.getPlatformSession ? await ctx.getPlatformSession(platform) : null;
      if (!native) {
        sendText(
          res,
          501,
          "application/javascript",
          `// rnrun: ${platform} bundles are not implemented yet -- native support is in progress.\n` +
            `throw new Error("rnrun: ${platform} bundles not implemented yet");\n`
        );
        return;
      }
      session = native;
    }
    if (!session.getBundle()) {
      sendText(
        res,
        500,
        "application/javascript",
        `// Build failed\nconsole.error(${JSON.stringify(session.buildError || "No bundle")});\n`
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "X-Metro-Files-Changed-Count": "0",
    });
    res.end(session.getBundle());
  });

  // --- DEBUG: inject raw code via /hot (dev-only diagnostics) ---
  router.path("POST", "/__debug/hot-inject", async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const clients = ctx.hub?.debugInjectHot(Buffer.concat(chunks).toString("utf8")) ?? -1;
      sendJson(res, 200, { clients });
    });
  });

  // --- Metro packager handshake ---
  router.path("GET", "/status", (_req, res) => {
    sendText(res, 200, "text/plain", "packager-status:running");
  });

  // --- Source map: web bundles inline their map today; external maps land
  //     with the native emit target. Valid empty map keeps devtools quiet. ---
  router.pattern("GET", /\.map$/, (_req, res) => {
    sendJson(res, 200, { version: 3, sources: [], names: [], mappings: "" });
  });

  // --- Symbolicate: map bundle frames back to module files. Line numbers
  //     within a module are approximate (the Hermes lowering pass rewrites
  //     module bodies), but file attribution is exact -- which is what makes
  //     a redbox actionable. ---
  router.path("POST", "/symbolicate", async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const { stack } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          stack: Array<{ file?: string; lineNumber?: number; column?: number; methodName?: string }>;
        };
        const session = ctx.getPlatformSession ? await ctx.getPlatformSession("ios") : null;
        const lineIndex = session?.getNativeLineIndex() || [];
        let codeFrame: { content: string; location: { row: number; column: number }; fileName: string } | null = null;

        const mapped = (stack || []).map((frame) => {
          if (!frame.file || !/\.bundle/.test(frame.file) || !frame.lineNumber) return frame;
          const entry = lineIndex.find((e) => frame.lineNumber! >= e.start && frame.lineNumber! <= e.end);
          if (!entry) return frame;
          // -1 for the __d factory header line.
          const relLine = Math.max(1, frame.lineNumber - entry.start - 1 + 1);
          const out = { ...frame, file: entry.key, lineNumber: relLine };
          if (!codeFrame && entry.key.startsWith("/") && session) {
            const src = session.getVfs().read(entry.key);
            if (src) {
              const lines = src.split("\n");
              const from = Math.max(0, relLine - 3);
              const to = Math.min(lines.length, relLine + 2);
              codeFrame = {
                content: lines
                  .slice(from, to)
                  .map((l, i) => `${from + i + 1 === relLine ? ">" : " "} ${from + i + 1} | ${l}`)
                  .join("\n"),
                location: { row: relLine, column: frame.column ?? 0 },
                fileName: entry.key,
              };
            }
          }
          return out;
        });
        sendJson(res, 200, { stack: mapped, codeFrame });
      } catch {
        sendJson(res, 200, { stack: [], codeFrame: null });
      }
    });
  });

  // --- Native asset bytes: RN's resolveAssetSource requests
  //     /assets/<dir>/<name>.<type>?platform=...&hash=... (and Expo Go also
  //     uses /assets?unstable_path=<encoded path>). Streamed from disk. ---
  router.add(
    "GET",
    (url) => {
      if (url.pathname === "/assets" && url.searchParams.get("unstable_path")) {
        return { rest: url.searchParams.get("unstable_path")! };
      }
      const m = url.pathname.match(/^\/assets\/(?<rest>.+)$/);
      return m ? { rest: decodeURIComponent(m.groups!.rest) } : null;
    },
    (_req, res, { params }) => {
      const vfsPath = params.rest.startsWith("/") ? params.rest : "/" + params.rest;
      let diskPath: string;
      try {
        diskPath = vfsToDisk(ctx.rootDir, vfsPath);
      } catch {
        sendText(res, 403, "text/plain", "Forbidden");
        return;
      }
      if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
        sendText(res, 404, "text/plain", "Asset not found: " + vfsPath);
        return;
      }
      res.writeHead(200, {
        "Content-Type": mimeFor(vfsPath),
        "Content-Length": fs.statSync(diskPath).size,
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(diskPath).pipe(res);
    }
  );

  // --- Device log forwarding (legacy HTTP channel) ---
  router.path("POST", "/logs", async (req, res) => {
    // Accept and print; body format is a JSON array of log entries.
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const entries = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const entry of Array.isArray(entries) ? entries : []) {
          const level = entry?.level || "info";
          const body = Array.isArray(entry?.body) ? entry.body.join(" ") : String(entry?.body ?? "");
          ctx.log(`[device:${level}] ${body}`);
        }
      } catch {
        // Ignore malformed log payloads.
      }
      sendJson(res, 200, {});
    });
  });

  // --- Inspector (stubbed; prevents error loops from debugger probes) ---
  router.pattern("GET", /^\/inspector\//, (_req, res) => {
    sendJson(res, 200, {});
  });
  router.path("GET", "/json", (_req, res) => sendJson(res, 200, []));
  router.path("GET", "/json/list", (_req, res) => sendJson(res, 200, []));
  router.path("GET", "/json/version", (_req, res) => sendJson(res, 200, {}));
}

function buildManifest(ctx: ServerContext, platform: string, host: string): object {
  const app = ctx.config.app;
  const name = app.name || ctx.title || "rnrun-app";
  const slug = app.slug || slugify(name);
  const sdkVersion = app.sdkVersion || sdkVersionFromProject(ctx) || "54.0.0";

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion: `exposdk:${sdkVersion}`,
    launchAsset: {
      key: "bundle",
      contentType: "application/javascript",
      url: `http://${host}/index.bundle?platform=${platform}&dev=true&hot=false&lazy=true`,
    },
    assets: [],
    metadata: {},
    extra: {
      eas: {},
      expoClient: {
        ...app,
        name,
        slug,
        sdkVersion,
        platforms: ["ios", "android", "web"],
        hostUri: host,
      },
      expoGo: {
        debuggerHost: host,
        developer: { tool: "rnrun", projectRoot: ctx.rootDir },
        packagerOpts: { dev: true },
        mainModuleName: "index",
      },
      // MUST be stable per project: Expo Go scopes storage by scopeKey, so a
      // per-request value (like the old prototype used) would make every load
      // look like a brand-new app.
      scopeKey: `@anonymous/${slug}-${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`,
    },
  };
}

function sdkVersionFromProject(ctx: ServerContext): string | null {
  const deps = (ctx.config.pkg?.dependencies || {}) as Record<string, string>;
  const expo = deps["expo"];
  if (!expo) return null;
  const major = expo.match(/(\d+)/)?.[1];
  return major ? `${major}.0.0` : null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
}
