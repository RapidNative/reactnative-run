/**
 * Source of the module rnrun prepends to every native (Expo Go) bundle.
 *
 * Its one job: keep the device in step with the dev server across events the
 * stock RN tooling doesn't recover from. RN's HMRClient never reconnects once
 * its /hot socket drops, so after a dev-server restart a phone sits on its old
 * bundle -- silently, or with "Requiring unknown module" once a patch from the
 * new server (different module ids) reaches it. Metro's answer is a yellow
 * "Metro has restarted since the last edit. Reload to reconnect." and a manual
 * reload; this makes the reload automatic.
 *
 * Mechanism: connect to /__rnrun with the client token from the bundle URL
 * (see server/clients.ts); reconnect with backoff whenever the socket drops;
 * DevSettings.reload() when the server says the bundle it served for this
 * token is not the one it is patching now. After the reload the same URL is
 * fetched again, the server's record for the token updates, and the next hello
 * matches -- so a reload can never loop.
 *
 * Constraints: ES5, Hermes-safe, no dependency on Expo internals, and inert
 * (returns early) when anything it needs is missing.
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
  var SourceCode = RN && RN.NativeModules && RN.NativeModules.SourceCode;
  var src = SourceCode && SourceCode.scriptURL;
  if (typeof src !== "string" || typeof WebSocket === "undefined") return;
  var m = /[?&]rnrunClient=([^&#]+)/.exec(src);
  if (!m) return;
  var origin = src.replace(/^(https?:\\/\\/[^\\/?#]+).*$/, "$1");
  if (origin === src) return;
  var platform = RN.Platform && RN.Platform.OS ? RN.Platform.OS : "";
  var url = origin.replace(/^http/, "ws") + "/__rnrun?token=" + m[1] + "&platform=" + platform;
  var retry = 1000;
  var reloading = false;
  function reload() {
    if (reloading) return;
    reloading = true;
    try { RN.DevSettings.reload("rnrun: the dev server changed"); } catch (e) { reloading = false; }
  }
  function connect() {
    var ws;
    try { ws = new WebSocket(url); } catch (e) { setTimeout(connect, retry); return; }
    ws.onopen = function () { retry = 1000; };
    ws.onmessage = function (e) {
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      if (d && d.type === "reload") reload();
    };
    ws.onerror = function () {};
    ws.onclose = function () {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  }
  connect();
})();
`;

/** Entry wrapper: the dev client first (it is inert on failure), then the app. */
export function nativeEntryWrapperSource(entry: string): string {
  return `require(".${NATIVE_DEV_CLIENT_PATH}");\nrequire(".${entry}");\n`;
}
