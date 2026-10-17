/**
 * Simulated safe-area insets, for a page shown inside a drawn phone frame (an
 * editor's player iframe). A desktop iframe has no notch or home indicator, so
 * env(safe-area-inset-*) resolves to 0 and apps render under the drawn chrome.
 *
 * Opt-in per page load: `?safeArea=top,right,bottom,left` in CSS px, e.g.
 * `?safeArea=59,0,34,0`. Without it nothing changes, so a phone opening the
 * same URL gets its real insets.
 *
 * Every reader has to see the same values:
 *  - react-native-safe-area-context (web) measures a hidden probe div whose
 *    INLINE paddings are env(safe-area-inset-*), synchronously after inserting
 *    it. An author !important rule outranks inline styles, so a stylesheet
 *    targeting the probe (the only element with both an env() inset padding
 *    and z-index -1 inline) controls what it reads back.
 *  - React Native's deprecated SafeAreaView (react-native-web) and any other
 *    CSS put env(safe-area-inset-*) in stylesheet rules, which react-native-web
 *    inserts at runtime. Those rules are rewritten to the px values as they go
 *    in (insertRule, replace/replaceSync, and <style> text), so the computed
 *    padding is the simulated inset.
 *
 * Runs before the bundle; inert on a malformed value; never throws.
 */
const SIMULATED_SAFE_AREA_SCRIPT = `(function () {
  try {
    var m = /[?&]safeArea=([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)(?:&|$)/.exec(location.search);
    if (!m) return;
    var px = { top: +m[1], right: +m[2], bottom: +m[3], left: +m[4] };
    globalThis.__RNRUN_SAFE_AREA__ = px;
    var ENV = /env\\(\\s*safe-area-inset-(top|right|bottom|left)\\s*(?:,[^()]*(?:\\([^()]*\\)[^()]*)*)?\\)/g;
    function rewrite(css) {
      return typeof css === "string" && css.indexOf("safe-area-inset") !== -1
        ? css.replace(ENV, function (_, side) { return px[side] + "px"; })
        : css;
    }
    var P = CSSStyleSheet.prototype;
    var insertRule = P.insertRule;
    P.insertRule = function (rule, index) { return insertRule.call(this, rewrite(rule), index); };
    if (P.replaceSync) { var rs = P.replaceSync; P.replaceSync = function (t) { return rs.call(this, rewrite(t)); }; }
    if (P.replace) { var rp = P.replace; P.replace = function (t) { return rp.call(this, rewrite(t)); }; }
    function fixStyle(el) {
      var t = el.textContent;
      var r = rewrite(t);
      if (r !== t) el.textContent = r;
    }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        var target = rec.target.nodeType === 3 ? rec.target.parentNode : rec.target;
        if (target && target.tagName === "STYLE") fixStyle(target);
        for (var j = 0; j < rec.addedNodes.length; j++) {
          var n = rec.addedNodes[j];
          if (n.tagName === "STYLE") fixStyle(n);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    var probe = document.createElement("style");
    probe.textContent = 'div[style*="safe-area-inset"][style*="z-index: -1"]{' +
      "padding-top:" + px.top + "px!important;padding-right:" + px.right + "px!important;" +
      "padding-bottom:" + px.bottom + "px!important;padding-left:" + px.left + "px!important}";
    document.head.appendChild(probe);
  } catch (e) {}
})();`;

/**
 * HTML shell for the web preview. Responsibilities:
 *  - define __DEV__/global before the bundle loads (react-native-web expects them);
 *  - load /index.bundle;
 *  - bridge the /__hmr WebSocket to window.postMessage, which the bundle's
 *    built-in HMR runtime already listens for (hmr-runtime.ts) -- so the
 *    runtime needs zero changes;
 *  - reload on server 'reload' frames, on the runtime's own
 *    'hmr-full-reload' escape hatch, and on reconnect version mismatch;
 *  - render a minimal build-error overlay.
 */
export function pageHtml(opts: { title: string; bundleVersion: number }): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(opts.title)}</title>
<style>
  html, body, #root { height: 100%; margin: 0; padding: 0; }
  /* Expo web template parity: react-native-web's app container is a flex:1
     child, which only stretches if #root is itself a flex container --
     without this every RN layout collapses to 0 height. */
  #root { display: flex; }
  #__rnrun_overlay {
    position: fixed; inset: 0; z-index: 2147483647; display: none;
    background: rgba(20, 8, 8, 0.96); color: #ffb4b4;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 24px; overflow: auto; white-space: pre-wrap;
  }
  #__rnrun_overlay h1 { font-size: 15px; color: #ff6b6b; margin: 0 0 12px; font-family: inherit; }
</style>
<script>
  globalThis.__DEV__ = true;
  globalThis.global = globalThis;
</script>
<script>${SIMULATED_SAFE_AREA_SCRIPT}</script>
</head>
<body>
<div id="root"></div>
<div id="__rnrun_overlay"><h1>Build error</h1><div id="__rnrun_overlay_msg"></div></div>
<script>
(function() {
  var BUNDLE_VERSION = ${opts.bundleVersion};
  var overlay = document.getElementById('__rnrun_overlay');
  var overlayMsg = document.getElementById('__rnrun_overlay_msg');
  function showError(msg) { overlayMsg.textContent = msg; overlay.style.display = 'block'; }
  function hideError() { overlay.style.display = 'none'; }

  // The bundle's HMR runtime posts this when an update has no accept boundary.
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'hmr-full-reload') location.reload();
  });

  var retryMs = 500;
  function connect() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__hmr');
    ws.onopen = function() { retryMs = 500; };
    ws.onmessage = function(e) {
      var data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      if (data.type === 'hmr-update') {
        hideError();
        window.postMessage({
          type: 'hmr-update',
          updatedModules: data.updatedModules,
          removedModules: data.removedModules,
          reverseDepsMap: data.reverseDepsMap
        }, '*');
        BUNDLE_VERSION = data.bundleVersion;
      } else if (data.type === 'reload') {
        location.reload();
      } else if (data.type === 'build-error') {
        showError(data.message);
      } else if (data.type === 'hello') {
        // Server restarted or bundle advanced while we were disconnected.
        if (data.bundleVersion !== BUNDLE_VERSION) location.reload();
      }
    };
    ws.onclose = function() {
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };
  }
  connect();
})();
</script>
<script src="/index.bundle?platform=web"></script>
</body>
</html>
`;
}

export function errorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head>
<body style="background:#140808;color:#ffb4b4;font:13px/1.5 ui-monospace,Menlo,monospace;padding:24px;white-space:pre-wrap">
<h1 style="font-size:15px;color:#ff6b6b">Build error</h1>
${escapeHtml(message)}
<script>
(function(){
  function connect(){
    var ws = new WebSocket('ws://' + location.host + '/__hmr');
    ws.onmessage = function(e){
      try { var d = JSON.parse(e.data); if (d.type === 'reload' || d.type === 'hmr-update') location.reload(); } catch(err) {}
    };
    ws.onclose = function(){ setTimeout(connect, 1000); };
  }
  connect();
})();
</script>
</body></html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
