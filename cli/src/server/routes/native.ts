import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mimeFor } from "../../project/assets.js";
import { vfsToDisk } from "../../project/scan.js";
import type { Router } from "../router.js";
import { sendText, sendJson } from "../router.js";
import type { ServerContext } from "../server.js";
import { CLIENT_TOKEN_PARAM, clientTokenFromUrl, newClientToken } from "../clients.js";

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
      // Behind a TLS-terminating proxy (the orchd gateway, Caddy) the request
      // reaches us over http but the device must fetch the bundle over the
      // external scheme -- an http bundle URL on an https host is a mixed-load
      // the device (iOS ATS) can reject. Trust X-Forwarded-Proto; default http.
      const fwdProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const scheme = fwdProto === "https" ? "https" : "http";
      const manifest = buildManifest(ctx, platform, host, scheme);
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
    if (platform === "web") {
      // Web is built lazily when startup pre-warmed only native platforms.
      await session.ensureBuilt();
    }
    if (platform !== "web") {
      const native = ctx.getPlatformSession ? await ctx.getPlatformSession(platform) : null;
      if (!native) {
        const reason = ctx.getPlatformError?.(platform);
        if (reason) {
          // Metro-shaped error body: Expo Go renders it as a redbox with the
          // message, instead of the app silently misbehaving later.
          sendText(res, 500, "application/json", JSON.stringify({
            type: "TransformError",
            name: "BuildError",
            message: reason,
            errors: [{ description: reason }],
          }));
          return;
        }
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
      // Metro parity: a JSON error body makes the RN bundle loader surface a
      // proper redbox with the message instead of a blank app. (Web's shell
      // reads the same shape for its overlay.)
      const message = session.buildError || "Bundle is not ready";
      sendText(
        res,
        500,
        "application/json",
        JSON.stringify({
          type: "TransformError",
          name: "BuildError",
          message,
          errors: [{ description: message }],
        })
      );
      return;
    }
    // Remember what this device is about to run, so the /hot handshake and
    // the dev client can tell later whether it is still in step (clients.ts).
    const token = platform !== "web" ? clientTokenFromUrl(url.href) : null;
    if (token) {
      ctx.clients?.record(token, { platform, epoch: session.epoch, version: session.bundleVersion });
    }
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "X-Metro-Files-Changed-Count": "0",
      // Content-Length (not chunked): Expo Go's loading screen computes its
      // download percentage from the total size, so without this the device
      // just says "Downloading..." with no progress. Metro sends it too.
      "Content-Length": Buffer.byteLength(session.getBundle()),
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

function buildManifest(ctx: ServerContext, platform: string, host: string, scheme: string): object {
  const app = ctx.config.app;
  const name = app.name || ctx.title || "rnrun-app";
  const slug = app.slug || slugify(name);
  const sdkVersion = app.sdkVersion || sdkVersionFromProject(ctx) || "54.0.0";

  // Anonymous mode: omit `developer.tool` so Expo Go's `isUsingDeveloperTool`
  // is false and the SDK 57 dev-server sign-in gate (physical iOS) is skipped.
  // Everything else the bundle needs (debuggerHost, packagerOpts, mainModuleName)
  // stays; only the dev-server flag -- and with it Fast Refresh -- is dropped.
  const expoGo: Record<string, unknown> = {
    debuggerHost: host,
    packagerOpts: { dev: true },
    mainModuleName: "index",
  };
  // Anonymous mode (drop `developer.tool`) exists ONLY to skip Expo Go's SDK 57
  // sign-in gate, which Expo enforces on iOS only. On Android the gate isn't
  // enforced, so an anonymous (non-dev) manifest buys nothing and actively hurts:
  // it routes Android through expo-updates, which gets stuck on "New update
  // available, downloading..." (the dev-server path, kept here, loads JS directly
  // and also restores Fast Refresh). So go anonymous for iOS only; Android always
  // stays a dev server.
  const anonymous = ctx.expoGoAnonymous && platform === "ios";
  if (!anonymous) {
    expoGo.developer = { tool: "rnrun", projectRoot: ctx.rootDir };
  }

  // Expo Go's expo-updates dedupes the launch bundle by launchAsset.key
  // (ExpoUpdatesUpdate.swift: UpdateAsset(key:) matched against its on-device DB).
  // A CONSTANT key makes a device that already downloaded once REUSE that cached
  // bundle forever and never re-fetch -- so an edit never shows in anonymous mode
  // (a first-load device is fine because it has no cached "bundle" asset yet).
  // Key it to the native session's epoch+bundleVersion, which bumps on every
  // rebuild: an edit yields a new key -> Expo Go re-downloads; unchanged code
  // keeps the key stable so a plain reload still serves from the device cache.
  // (Dev mode loads JS via the RN dev-server path, not expo-updates, so this
  // only matters for anonymous mode -- but it's correct and cheap either way.)
  // The fallback (no native session yet) MUST be stable across manifest fetches.
  // A per-fetch random token here makes Expo Go's expo-updates see a "new update"
  // on every poll and loop forever on "New update available, downloading..." --
  // it never converges to a launch. This bit Android specifically: the image
  // prewarms iOS only, so iOS always has a session (stable epoch-version key)
  // while Android starts session-less and got a fresh random key each poll.
  // A stable per-platform key can't loop; once the first bundle build creates
  // the session it upgrades to the versioned key (one clean re-fetch), which is
  // what busts the cache on later edits.
  const nativeSession = ctx.peekPlatformSession?.(platform);
  const bundleKey = nativeSession
    ? `bundle-${nativeSession.epoch}-${nativeSession.bundleVersion}`
    : `bundle-${platform}-pending`;

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion: `exposdk:${sdkVersion}`,
    launchAsset: {
      key: bundleKey,
      contentType: "application/javascript",
      // One token per manifest fetch (i.e. per device launch). The device
      // registers on /hot with this exact URL and its SourceCode.scriptURL is
      // this URL, which is how the server knows which bundle it is running.
      url: `${scheme}://${host}/index.bundle?platform=${platform}&dev=true&hot=false&lazy=true&${CLIENT_TOKEN_PARAM}=${newClientToken()}`,
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
      expoGo,
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
