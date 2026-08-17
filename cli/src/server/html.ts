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
