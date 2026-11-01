/**
 * Source of the module rnrun prepends to every native (Expo Go) bundle.
 *
 * Its first job: keep the device in step with the dev server across events the
 * stock RN tooling doesn't recover from. RN's HMRClient never reconnects once
 * its /hot socket drops, so after a dev-server restart a phone sits on its old
 * bundle -- silently, or with "Requiring unknown module" once a patch from the
 * new server (different module ids) reaches it. Metro's answer is a yellow
 * "Metro has restarted since the last edit. Reload to reconnect." and a manual
 * reload; this makes the reload automatic.
 *
 * Mechanism: connect to /__rnrun with the client token from the bundle URL
 * (see server/clients.ts); reconnect with backoff whenever the socket drops;
 * reload when the server says the bundle it served for this token is not the
 * one it is patching now. After the reload the same URL is fetched again, the
 * server's record for the token updates, and the next hello matches -- so a
 * reload can never loop.
 *
 * Its second job: Fast Refresh when Expo Go won't do it. An anonymous manifest
 * (no `developer.tool`, see routes/native.ts) lets Expo Go on a phone skip its
 * sign-in gate, but it then runs the bundle as a published update: RN's
 * HMRClient connects to /hot yet applies nothing, and a reload (ExpoUpdates or
 * DevSettings alike) replays the bundle the phone first downloaded instead of
 * fetching a new one. So this client applies patches itself: it registers on
 * /hot with the tag of the bundle it runs (the manifest's launch-asset key,
 * advanced by each patch it applies), evals each update's __d(...) modules
 * (metro-runtime then hot-swaps them and runs React Refresh, as with Metro's
 * own client), and skips a broadcast patch made for another bundle, then
 * reconnects for the catch-up patch that fits. A /message reload means the
 * same here: re-register, and take whatever patch the server has. When the
 * server can't patch it at all (`rnrun-stale`), it stops applying patches and
 * asks the user to reopen the project, which is the one thing that fetches a
 * new bundle.
 *
 * The bundle URL comes from SourceCode.getConstants() (on the new architecture
 * NativeModules.SourceCode.scriptURL is undefined), or from the manifest when
 * Expo Go launched the bundle from its own cache and the script is a file.
 *
 * Constraints: ES5, Hermes-safe, and inert (returns early) when anything it
 * needs is missing. Expo internals (the manifest, ExpoUpdates) are read only
 * to detect and serve the anonymous case.
 */
export const NATIVE_DEV_CLIENT_PATH = "/__rnrun_dev_client.js";
export const NATIVE_ENTRY_WRAPPER_PATH = "/__rnrun_native_entry.js";

export const NATIVE_DEV_CLIENT_SOURCE = `/* rnrun native dev client */
(function () {
  var g = typeof globalThis !== "undefined" ? globalThis : typeof global !== "undefined" ? global : this;
  if (!g || g.__rnrunDevClient) return;
  g.__rnrunDevClient = true;
  var RN;
  try { RN = require("react-native"); } catch (e) { return; }
  if (typeof WebSocket === "undefined") return;
  var modules = g.expo && g.expo.modules;
  var manifest = null;
  try {
    manifest = modules.ExponentConstants.manifest;
    if (typeof manifest === "string") manifest = JSON.parse(manifest);
  } catch (e) {}
  var expoGo = manifest && manifest.extra && manifest.extra.expoGo;
  var anonymous = !!expoGo && !expoGo.developer;
  var launch = (manifest && manifest.launchAsset) || {};
  var SourceCode = RN.NativeModules && RN.NativeModules.SourceCode;
  var src;
  try { src = SourceCode.getConstants().scriptURL; } catch (e) {}
  if (typeof src !== "string") src = SourceCode && SourceCode.scriptURL;
  if (!/^https?:/.test(typeof src === "string" ? src : "") && typeof launch.url === "string") src = launch.url;
  if (typeof src !== "string") return;
  var m = /[?&]rnrunClient=([^&#]+)/.exec(src);
  if (!m) return;
  var origin = src.replace(/^(https?:\\/\\/[^\\/?#]+).*$/, "$1");
  if (origin === src) return;
  var wsOrigin = origin.replace(/^http/, "ws");
  var platform = RN.Platform && RN.Platform.OS ? RN.Platform.OS : "";
  var tag = typeof launch.key === "string" ? launch.key.replace(/^bundle-/, "") : "unknown";
  var reloading = false;
  function devSettingsReload() {
    try { RN.DevSettings.reload("rnrun: the dev server changed"); } catch (e) { reloading = false; }
  }
  function reload() {
    if (reloading) return;
    reloading = true;
    var updates = anonymous && modules && modules.ExpoUpdates;
    if (updates && typeof updates.reload === "function") {
      try {
        var p = updates.reload();
        if (p && typeof p.then === "function") p.then(null, devSettingsReload);
        return;
      } catch (e) {}
    }
    devSettingsReload();
  }
  function connect(url, onMessage, onOpen) {
    var retry = 1000;
    function open() {
      var ws;
      try { ws = new WebSocket(url); } catch (e) { setTimeout(open, retry); return; }
      ws.onopen = function () {
        retry = 1000;
        if (onOpen) onOpen(ws);
      };
      ws.onmessage = function (e) {
        var d;
        try { d = JSON.parse(e.data); } catch (err) { return; }
        if (d) onMessage(d, ws);
      };
      ws.onerror = function () {};
      ws.onclose = function () {
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 5000);
      };
    }
    open();
  }
  connect(wsOrigin + "/__rnrun?token=" + m[1] + "&platform=" + platform + (anonymous ? "&anonymous=1" : ""), function (d) {
    if (d.type === "reload") reload();
  });
  if (!anonymous) return;
  var evalGlobal = eval;
  var stale = false;
  var hot = null;
  function inject(mod) {
    if (mod && mod.module) evalGlobal(mod.module[1]);
  }
  connect(wsOrigin + "/hot", function (d, ws) {
    if (stale) return;
    if (d.type === "update" && d.body) {
      var body = d.body;
      if (!body.isInitialUpdate && body.rnrunBase && body.rnrunBase !== tag) {
        ws.close();
        return;
      }
      try {
        (body.added || []).forEach(inject);
        (body.modified || []).forEach(inject);
        if (body.rnrunBundle) tag = body.rnrunBundle;
      } catch (e) {
        console.error("rnrun: could not apply an update, reloading. " + (e && e.message));
        reload();
      }
    } else if (d.type === "rnrun-stale") {
      stale = true;
      console.log("rnrun: this bundle can't be updated in place (" + d.reason + ")");
      try {
        RN.Alert.alert("Preview updated", "This change can't be applied while the app is open. Close the project in Expo Go and open it again to see it.");
      } catch (e) {}
    } else if (d.type === "error" && d.body) {
      console.error(d.body.message || "rnrun: the last edit failed to build");
    }
  }, function (ws) {
    hot = ws;
    ws.send(JSON.stringify({ type: "register-entrypoints", entryPoints: [src], rnrunBundle: tag }));
  });
  connect(wsOrigin + "/message", function (d) {
    if (d.method === "reload" && hot) hot.close();
  });
})();
`;

/**
 * Optional project-supplied module that runs after the dev client and before
 * the app's entry, on native (Expo Go) bundles only. A host that serves
 * projects through rnrun can drop a file here to add device-only behaviour
 * (an overlay, instrumentation) without touching the project's own code:
 * nothing in the app imports it. Its presence is read when the bundle is
 * built from scratch, so a file added to a running server takes effect on the
 * next full build (a restart).
 */
export const NATIVE_PRE_ENTRY_PATH = "/.rnrun/pre-entry.js";

/** Entry wrapper: the dev client first (it is inert on failure), then the
 *  optional pre-entry module, then the app. */
export function nativeEntryWrapperSource(entry: string, preEntry?: string | null): string {
  const pre = preEntry ? `require(".${preEntry}");\n` : "";
  return `require(".${NATIVE_DEV_CLIENT_PATH}");\n${pre}require(".${entry}");\n`;
}
