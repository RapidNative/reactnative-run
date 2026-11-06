import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Router } from "../router.js";
import { sendText } from "../router.js";
import type { ServerContext } from "../server.js";
import { acceptsGzip, gzipCached } from "../compress.js";
import {
  DOM_BUNDLE_PREFIX,
  DOM_EVENTS_PATH,
  DOM_PAGE_PREFIX,
  domFileUrl,
  vfsPathFromFileParam,
} from "../../bundler/dom-components.js";

/**
 * Inline polyfills for legacy WebViews (Android 9), copied from @expo/cli's
 * domPolyfills.ts so a DOM page behaves the same under rnrun as under
 * `expo start`. They run before any application code.
 */
const DOM_POLYFILLS_SCRIPT = `
if (typeof globalThis === "undefined") {
  var _g = typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : self;
  _g.globalThis = _g;
}
if (!Array.prototype.flat) {
  Array.prototype.flat = function flat(depth) {
    depth = depth === undefined ? 1 : Math.floor(Number(depth));
    if (depth < 1) return Array.prototype.slice.call(this);
    return Array.prototype.reduce.call(this, function (acc, val) {
      if (Array.isArray(val)) acc.push.apply(acc, flat.call(val, depth - 1));
      else acc.push(val);
      return acc;
    }, []);
  };
}
try {
  performance.measure("__expo_feature_test", { start: 0 });
  performance.clearMeasures("__expo_feature_test");
} catch (e) {
  var _origMeasure = performance.measure.bind(performance);
  performance.measure = function (name, startOrOptions, endMark) {
    if (startOrOptions && typeof startOrOptions === "object") return _origMeasure(name);
    return _origMeasure(name, startOrOptions, endMark);
  };
}
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Reload this page when the server says its bundle changed (or it restarted). */
function reloadScript(eventsUrl: string, version: string): string {
  return `<script>
(function () {
  var VERSION = ${JSON.stringify(version)};
  var retryMs = 500;
  function connect() {
    var ws;
    try {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + ${JSON.stringify(eventsUrl)});
    } catch (e) { return; }
    ws.onopen = function () { retryMs = 500; };
    ws.onmessage = function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      if (d.type === "reload") location.reload();
      else if (d.type === "hello" && d.version !== VERSION) location.reload();
    };
    ws.onclose = function () {
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };
  }
  connect();
})();
</script>`;
}

/**
 * The page a DOM component's WebView loads: @expo/cli's getDomComponentHtml,
 * plus the globals rnrun's web bundles expect before they run (the app's web
 * shell sets the same) and a reload channel standing in for Metro's HMR.
 */
export function domPageHtml(opts: { title: string; bundleUrl: string; eventsUrl: string; version: string }): string {
  return `<!DOCTYPE html>
<html>
    <head>
        <meta charset="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <title>${escapeHtml(opts.title)}</title>
        <style id="expo-dom-component-style">
        /* These styles make the body full-height */
        html,
        body {
          -webkit-overflow-scrolling: touch; /* Enables smooth momentum scrolling */
        }
        /* These styles make the root element full-height */
        #root {
          display: flex;
          flex: 1;
        }
        </style>
    </head>
    <body>
    <noscript>DOM Components require <code>javaScriptEnabled</code></noscript>
        <!-- Root element for the DOM component. -->
        <div id="root"></div>
        <script>${DOM_POLYFILLS_SCRIPT}</script>
        <script>
          globalThis.__DEV__ = true;
          globalThis.global = globalThis;
        </script>
        <script>
          var injectedObject = {};
          try {
            injectedObject = JSON.parse(window.ReactNativeWebView.injectedObjectJson());
          } catch (e) {
            throw new Error('Failed to parse injectedObjectJson: ' + e.message);
          }
          window.$$EXPO_DOM_HOST_OS = injectedObject.EXPO_DOM_HOST_OS;
          window.$$EXPO_INITIAL_PROPS = injectedObject.initialProps;
        </script>
        ${reloadScript(opts.eventsUrl, opts.version)}
        <script crossorigin src="${escapeHtml(opts.bundleUrl)}"></script>
    </body>
</html>`;
}

/** A build error, in the WebView where the component would be. */
export function domErrorHtml(opts: { title: string; message: string; eventsUrl: string }): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;background:#140808;color:#ffb4b4;font:12px/1.5 ui-monospace,Menlo,monospace;padding:12px;white-space:pre-wrap">
<div style="font-size:13px;color:#ff6b6b;margin-bottom:8px">DOM component build error</div>${escapeHtml(opts.message)}
${reloadScript(opts.eventsUrl, "error")}
</body></html>`;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export interface DomRoutes {
  /** Takes the DOM pages' reload socket; false for any other upgrade. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

/**
 * Expo DOM components (see bundler/dom-components.ts):
 *  - GET /_expo/@dom/<name>?file=<file URL>  the page (what expo/dom's WebView opens)
 *  - GET /__rnrun/dom-bundle/<name>.js?file=  its web bundle
 *  - WS  /__rnrun/dom-events?file=            reload when that bundle changes
 * Registered before the native routes: those claim any path ending in .bundle.
 */
export function registerDomRoutes(router: Router, ctx: ServerContext): DomRoutes {
  const sockets = new WebSocketServer({ noServer: true });
  const byPath = new Map<string, Set<WebSocket>>();
  let unsubscribed: (() => void) | null = null;
  let subscribedTo: unknown = null;

  /** The DOM component sessions, subscribing to their changes once. */
  const components = () => {
    const dom = ctx.domComponents ?? null;
    if (dom && subscribedTo !== dom) {
      unsubscribed?.();
      subscribedTo = dom;
      unsubscribed = dom.onChange((vfsPath) => {
        for (const ws of byPath.get(vfsPath) ?? []) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reload" }));
        }
      });
    }
    return dom;
  };
  components();

  const resolve = (url: URL) => vfsPathFromFileParam(url.searchParams.get("file"), ctx.rootDir);
  const urlsFor = (vfsPath: string) => {
    const file = encodeURIComponent(domFileUrl(vfsPath));
    return {
      bundle: `${DOM_BUNDLE_PREFIX}${encodeURIComponent(basename(vfsPath))}.js?file=${file}`,
      events: `${DOM_EVENTS_PATH}?file=${file}`,
    };
  };

  router.add(
    "GET",
    (url) => (url.pathname === DOM_PAGE_PREFIX || url.pathname.startsWith(DOM_PAGE_PREFIX + "/") ? {} : null),
    async (_req, res, { url }) => {
      const dom = components();
      if (!dom) {
        sendText(res, 501, "text/plain", "DOM components are not enabled on this server");
        return;
      }
      const file = url.searchParams.get("file");
      const vfsPath = resolve(url);
      if (!vfsPath) {
        // @expo/cli answers the same.
        sendText(res, 400, "text/plain", "Invalid file path: " + file);
        return;
      }
      if (!dom.isDomComponent(vfsPath)) {
        sendText(res, 404, "text/plain", `Not a DOM component ("use dom"): ${vfsPath}`);
        return;
      }
      const session = await dom.get(vfsPath);
      const urls = urlsFor(vfsPath);
      if (!session || !session.getBundle()) {
        const message = session?.buildError || "Bundle is not ready";
        sendText(res, 200, "text/html", domErrorHtml({ title: basename(vfsPath), message, eventsUrl: urls.events }));
        return;
      }
      sendText(
        res,
        200,
        "text/html",
        domPageHtml({
          title: basename(vfsPath),
          // The version pins the bytes this page was rendered against.
          bundleUrl: `${urls.bundle}&v=${encodeURIComponent(session.bundleTag)}`,
          eventsUrl: urls.events,
          version: session.bundleTag,
        })
      );
    }
  );

  router.add(
    "GET",
    (url) => (url.pathname.startsWith(DOM_BUNDLE_PREFIX) ? {} : null),
    async (req, res, { url }) => {
      const dom = components();
      const vfsPath = resolve(url);
      if (!dom || !vfsPath || !dom.isDomComponent(vfsPath)) {
        sendText(res, 404, "application/javascript", "// rnrun: no such DOM component\n");
        return;
      }
      const session = await dom.get(vfsPath);
      const bundle = session?.getBundle();
      if (!session || !bundle) {
        const message = session?.buildError || "Bundle is not ready";
        sendText(res, 500, "application/javascript", `throw new Error(${JSON.stringify("rnrun: " + message)});\n`);
        return;
      }
      const headers = {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      };
      if (acceptsGzip(req.headers["accept-encoding"])) {
        const gz = await gzipCached("dom:" + vfsPath, bundle).catch(() => null);
        if (gz) {
          res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": gz.length });
          res.end(gz);
          return;
        }
      }
      res.writeHead(200, { ...headers, "Content-Length": Buffer.byteLength(bundle) });
      res.end(bundle);
    }
  );

  sockets.on("connection", (ws, req: IncomingMessage) => {
    const url = new URL(req.url || "/", "http://localhost");
    const vfsPath = resolve(url);
    if (!vfsPath) {
      ws.close();
      return;
    }
    let set = byPath.get(vfsPath);
    if (!set) byPath.set(vfsPath, (set = new Set()));
    set.add(ws);
    ws.on("close", () => set!.delete(ws));
    // After a reconnect (a server restart), a page on other bytes reloads.
    void components()
      ?.get(vfsPath)
      .then((session) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const version = session?.getBundle() ? session.bundleTag : "error";
        ws.send(JSON.stringify({ type: "hello", version }));
      })
      .catch(() => {});
  });

  return {
    handleUpgrade(req, socket, head) {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== DOM_EVENTS_PATH) return false;
      sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
      return true;
    },
    close() {
      unsubscribed?.();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
    },
  };
}
