import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import type { FileMap } from "almostmetro";
import { EditorFS } from "./editor-fs";

interface Projects {
  [projectName: string]: FileMap;
}

interface ConsoleEntry {
  text: string;
  type: string;
  error?: {
    message: string;
    file: string | null;
    line: number | null;
    column: number | null;
    stack: Array<{ fn: string; file: string; line: number; column: number }>;
  };
}

function bundleInWorker(
  worker: Worker,
  files: FileMap,
  packageServerUrl: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "result") {
        resolve(e.data.code);
      } else if (e.data.type === "error") {
        reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ files, packageServerUrl });
  });
}

// --- PreviewFrame: reusable blob-URL iframe wrapper ---

interface PreviewFrameHandle {
  postMessage: (data: any) => void;
  getRouteHash: () => string;
}

interface PreviewFrameProps {
  blobUrl: string;
  route: string; // e.g. "#/" or "#/explore"
}

const PreviewFrame = forwardRef<PreviewFrameHandle, PreviewFrameProps>(
  function PreviewFrame({ blobUrl, route }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useImperativeHandle(ref, () => ({
      postMessage(data: any) {
        iframeRef.current?.contentWindow?.postMessage(data, "*");
      },
      getRouteHash(): string {
        try {
          return (iframeRef.current?.contentWindow as any)?.__ROUTER_SHIM_HASH__ || "";
        } catch {
          return "";
        }
      },
    }));

    useEffect(() => {
      const iframe = iframeRef.current;
      if (!blobUrl || !iframe) return;

      // Preserve current route from the running iframe (if any)
      let preservedHash = "";
      try {
        preservedHash = (iframe.contentWindow as any)?.__ROUTER_SHIM_HASH__ || "";
      } catch (_) {}

      iframe.src = blobUrl + (preservedHash || route);
    }, [blobUrl]);

    return (
      <iframe
        ref={iframeRef}
        className="preview-iframe"
        sandbox="allow-scripts allow-same-origin"
      />
    );
  },
);

// --- Extract inline source map from bundle code ---

function extractInlineSourceMap(
  code: string,
): { sources: string[]; mappings: string } | null {
  const marker = "//# sourceMappingURL=data:application/json;base64,";
  const idx = code.lastIndexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  let end = code.indexOf("\n", start);
  if (end === -1) end = code.length;
  const b64 = code.slice(start, end).trim();
  try {
    const json = JSON.parse(atob(b64));
    return { sources: json.sources || [], mappings: json.mappings || "" };
  } catch {
    return null;
  }
}

// --- Build the HTML document that wraps the bundle ---

function buildBundleHtml(
  jsBlobUrl: string,
  sourceMap: { sources: string[]; mappings: string } | null,
): string {
  // Script 1: Console interception (forwards console.* to parent)
  const consoleScript =
    "['log','warn','error','info'].forEach(function(method) {\n" +
    "  var orig = console[method];\n" +
    "  console[method] = function() {\n" +
    "    var args = Array.prototype.slice.call(arguments);\n" +
    "    var text = args.map(function(a) {\n" +
    "      if (typeof a === 'object') try { return JSON.stringify(a); } catch(e) { return String(a); }\n" +
    "      return String(a);\n" +
    "    }).join(' ');\n" +
    "    window.parent.postMessage({ type: 'console', method: method, text: text }, '*');\n" +
    "    if (orig) orig.apply(console, arguments);\n" +
    "  };\n" +
    "});\n";

  // Script 2: Source map resolver + error handlers (ES5-compatible)
  const smResolverScript =
    // --- Mini VLQ decoder ---
    "(function() {\n" +
    "var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n" +
    "var B64D = {};\n" +
    "for (var i = 0; i < B64.length; i++) B64D[B64[i]] = i;\n" +
    "\n" +
    "function decodeVLQ(str, offset) {\n" +
    "  var result = 0, shift = 0, cont, idx = offset;\n" +
    "  do {\n" +
    "    var d = B64D[str[idx++]];\n" +
    "    cont = (d & 32) !== 0;\n" +
    "    result += (d & 31) << shift;\n" +
    "    shift += 5;\n" +
    "  } while (cont);\n" +
    "  return { value: (result & 1) ? -(result >> 1) : (result >> 1), next: idx };\n" +
    "}\n" +
    "\n" +
    // --- Decode mappings string into lines of segments ---
    "function decodeMappings(mappings) {\n" +
    "  var lines = [], srcIdx = 0, origLine = 0, origCol = 0;\n" +
    "  var parts = mappings.split(';');\n" +
    "  for (var li = 0; li < parts.length; li++) {\n" +
    "    var segs = [], genCol = 0, lineStr = parts[li];\n" +
    "    if (lineStr) {\n" +
    "      var segParts = lineStr.split(',');\n" +
    "      for (var si = 0; si < segParts.length; si++) {\n" +
    "        var s = segParts[si]; if (!s) continue;\n" +
    "        var pos = 0, f = [];\n" +
    "        while (pos < s.length) { var r = decodeVLQ(s, pos); f.push(r.value); pos = r.next; }\n" +
    "        if (f.length >= 4) {\n" +
    "          genCol += f[0]; srcIdx += f[1]; origLine += f[2]; origCol += f[3];\n" +
    "          segs.push([genCol, srcIdx, origLine, origCol]);\n" +
    "        } else if (f.length >= 1) {\n" +
    "          genCol += f[0]; segs.push([genCol]);\n" +
    "        }\n" +
    "      }\n" +
    "    }\n" +
    "    lines.push(segs);\n" +
    "  }\n" +
    "  return lines;\n" +
    "}\n" +
    "\n" +
    // --- Source map store: url -> { sources, decoded } ---
    "var maps = {};\n" +
    "\n" +
    "function addMap(url, mapData) {\n" +
    "  maps[url] = { sources: mapData.sources, decoded: decodeMappings(mapData.mappings) };\n" +
    "}\n" +
    "\n" +
    "function resolve(url, line, col) {\n" +
    "  var m = maps[url];\n" +
    "  if (!m) return null;\n" +
    "  var decoded = m.decoded;\n" +
    "  if (line < 0 || line >= decoded.length) return null;\n" +
    "  var segs = decoded[line];\n" +
    "  if (!segs || segs.length === 0) return null;\n" +
    "  var best = null;\n" +
    "  for (var i = 0; i < segs.length; i++) {\n" +
    "    var seg = segs[i];\n" +
    "    if (seg.length < 4) continue;\n" +
    "    if (seg[0] <= col) best = seg;\n" +
    "  }\n" +
    "  if (!best) {\n" +
    "    for (var j = 0; j < segs.length; j++) { if (segs[j].length >= 4) { best = segs[j]; break; } }\n" +
    "  }\n" +
    "  if (!best) return null;\n" +
    "  return { file: m.sources[best[1]] || '(unknown)', line: best[2] + 1, column: best[3] + 1 };\n" +
    "}\n" +
    "\n" +
    // --- Extract inline source map from code string ---
    "function extractInlineSM(code) {\n" +
    "  var marker = '//# sourceMappingURL=data:application/json;base64,';\n" +
    "  var idx = code.lastIndexOf(marker);\n" +
    "  if (idx === -1) return null;\n" +
    "  var start = idx + marker.length;\n" +
    "  var end = code.indexOf('\\n', start);\n" +
    "  if (end === -1) end = code.length;\n" +
    "  try { return JSON.parse(atob(code.slice(start, end).trim())); } catch(e) { return null; }\n" +
    "}\n" +
    "\n" +
    // --- Extract sourceURL from code string ---
    "function extractSourceURL(code) {\n" +
    "  var marker = '//# sourceURL=';\n" +
    "  var idx = code.lastIndexOf(marker);\n" +
    "  if (idx === -1) return null;\n" +
    "  var start = idx + marker.length;\n" +
    "  var end = code.indexOf('\\n', start);\n" +
    "  if (end === -1) end = code.length;\n" +
    "  return code.slice(start, end).trim();\n" +
    "}\n" +
    "\n" +
    // --- Global __SM API ---
    "window.__SM = {\n" +
    "  init: function(url, mapData) { addMap(url, mapData); },\n" +
    "  add: function(url, mapData) { addMap(url, mapData); },\n" +
    "  resolve: resolve\n" +
    "};\n" +
    "\n" +
    // --- HMR listener: extract per-module source maps ---
    "window.addEventListener('message', function(e) {\n" +
    "  if (!e.data || e.data.type !== 'hmr-update') return;\n" +
    "  var mods = e.data.updatedModules;\n" +
    "  if (!mods) return;\n" +
    "  for (var key in mods) {\n" +
    "    var code = mods[key];\n" +
    "    if (typeof code !== 'string') continue;\n" +
    "    var sm = extractInlineSM(code);\n" +
    "    var sourceURL = extractSourceURL(code);\n" +
    "    if (sm && sourceURL) {\n" +
    "      window.__SM.add(sourceURL, sm);\n" +
    "    }\n" +
    "  }\n" +
    "});\n" +
    "\n" +
    // --- Stack trace parser (Chrome format) ---
    "function parseStack(stack) {\n" +
    "  if (!stack) return [];\n" +
    "  var frames = [];\n" +
    "  var lines = stack.split('\\n');\n" +
    "  for (var i = 0; i < lines.length; i++) {\n" +
    "    var line = lines[i].trim();\n" +
    "    var m = line.match(/^at\\s+(.+?)\\s+\\((.+?):(\\d+):(\\d+)\\)$/);\n" +
    "    if (m) { frames.push({ fn: m[1], file: m[2], line: parseInt(m[3],10), column: parseInt(m[4],10) }); continue; }\n" +
    "    m = line.match(/^at\\s+(.+?):(\\d+):(\\d+)$/);\n" +
    "    if (m) { frames.push({ fn: '(anonymous)', file: m[1], line: parseInt(m[2],10), column: parseInt(m[3],10) }); }\n" +
    "  }\n" +
    "  return frames;\n" +
    "}\n" +
    "\n" +
    // --- Resolve a single position ---
    "function resolvePosition(url, line, col) {\n" +
    "  var resolved = resolve(url, line - 1, col - 1);\n" +
    "  if (resolved) return resolved;\n" +
    "  return { file: url, line: line, column: col };\n" +
    "}\n" +
    "\n" +
    // --- Send resolved error to parent ---
    "function sendError(msg, url, line, col, err) {\n" +
    "  var pos = resolvePosition(url || '', line || 0, col || 0);\n" +
    "  var rawFrames = parseStack(err && err.stack);\n" +
    "  var resolvedFrames = [];\n" +
    "  for (var i = 0; i < rawFrames.length; i++) {\n" +
    "    var f = rawFrames[i];\n" +
    "    var rp = resolve(f.file, f.line - 1, f.column - 1);\n" +
    "    if (rp) resolvedFrames.push({ fn: f.fn, file: rp.file, line: rp.line, column: rp.column });\n" +
    "    else resolvedFrames.push(f);\n" +
    "  }\n" +
    "  window.parent.postMessage({\n" +
    "    type: 'runtime-error',\n" +
    "    message: typeof msg === 'string' ? msg : String(msg),\n" +
    "    file: pos.file,\n" +
    "    line: pos.line,\n" +
    "    column: pos.column,\n" +
    "    stack: resolvedFrames\n" +
    "  }, '*');\n" +
    "}\n" +
    "\n" +
    // --- Error handlers ---
    "window.onerror = function(msg, url, line, col, err) {\n" +
    "  sendError(msg, url, line, col, err);\n" +
    "};\n" +
    "window.addEventListener('unhandledrejection', function(e) {\n" +
    "  var err = e.reason;\n" +
    "  var msg = (err && err.message) ? err.message : String(err);\n" +
    "  sendError('Unhandled Promise Rejection: ' + msg, '', 0, 0, err instanceof Error ? err : null);\n" +
    "});\n" +
    "})();\n";

  // Script 3: Source map init (conditional)
  let smInitScript = "";
  if (sourceMap) {
    const smJson = JSON.stringify({ sources: sourceMap.sources, mappings: sourceMap.mappings });
    smInitScript =
      "<script>window.__SM.init(" +
      JSON.stringify(jsBlobUrl) +
      "," +
      smJson +
      ");</" +
      "script>\n";
  }

  return (
    "<!DOCTYPE html><html><head><meta charset='UTF-8'><style>html,body,#root{height:100%;margin:0}body{overflow:hidden}#root{display:flex;flex-direction:column}</style></head><body><div id='root'></div><script>\n" +
    consoleScript +
    smResolverScript +
    "</" +
    "script>\n" +
    smInitScript +
    '<script src="' +
    jsBlobUrl +
    '"></' +
    "script>\n" +
    "</body></html>"
  );
}

// --- Main App ---

type MobileTab = "editor" | "preview" | "console";

export function App() {
  const [projects, setProjects] = useState<Projects>({});
  const [currentProject, setCurrentProject] = useState("basic");
  const [fileList, setFileList] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [editorValue, setEditorValue] = useState("");
  const [consoleOutput, setConsoleOutput] = useState<ConsoleEntry[]>([]);
  const [bundling, setBundling] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("editor");
  const [watchMode, setWatchMode] = useState(false);
  const [hmrReady, setHmrReady] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const editorFSRef = useRef<EditorFS | null>(null);
  const lastBundleRef = useRef<string>("");
  const [hasBundle, setHasBundle] = useState(false);

  // Blob URLs for preview iframes (built once, loaded by all frames)
  const [blobUrl, setBlobUrl] = useState("");
  const prevBlobUrlRef = useRef("");
  const prevJsBlobUrlRef = useRef("");

  // Preview frame refs
  const frame1Ref = useRef<PreviewFrameHandle>(null);
  const frame2Ref = useRef<PreviewFrameHandle>(null);

  function broadcastToFrames(data: any) {
    frame1Ref.current?.postMessage(data);
    frame2Ref.current?.postMessage(data);
  }

  function updateBundle(bundleCode: string) {
    if (prevJsBlobUrlRef.current) URL.revokeObjectURL(prevJsBlobUrlRef.current);
    if (prevBlobUrlRef.current) URL.revokeObjectURL(prevBlobUrlRef.current);
    const jsBlob = new Blob([bundleCode], { type: "application/javascript" });
    const jsUrl = URL.createObjectURL(jsBlob);
    prevJsBlobUrlRef.current = jsUrl;
    const sm = extractInlineSourceMap(bundleCode);
    const html = buildBundleHtml(jsUrl, sm);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    prevBlobUrlRef.current = url;
    setBlobUrl(url);
  }

  // Initialize bundler worker
  useEffect(() => {
    workerRef.current = new Worker(
      new URL("./bundler.worker.ts", import.meta.url),
      { type: "module" },
    );
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Load projects on mount
  useEffect(() => {
    fetch("/projects.json")
      .then((res) => res.json())
      .then((data: Projects) => {
        setProjects(data);
        const params = new URLSearchParams(window.location.search);
        const project = params.get("project") || "basic";
        setCurrentProject(project);
        const projectFiles = data[project];
        if (projectFiles) {
          editorFSRef.current = new EditorFS(projectFiles);
          setFileList(Object.keys(projectFiles));
          const entry = findEntryFile(projectFiles);
          setActiveFile(entry);
          setEditorValue(projectFiles[entry] || "");
        }
      });
  }, []);

  // Listen for messages from iframes
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data) return;

      if (data.type === "runtime-error") {
        const loc = data.file && data.line ? ` at ${data.file}:${data.line}` : "";
        setConsoleOutput((prev) => [
          ...prev,
          {
            text: data.message + loc,
            type: "error",
            error: {
              message: data.message,
              file: data.file || null,
              line: data.line || null,
              column: data.column || null,
              stack: data.stack || [],
            },
          },
        ]);
      } else if (data.type === "console") {
        setConsoleOutput((prev) => [
          ...prev,
          { text: data.text, type: data.method === "log" ? "line" : data.method },
        ]);
      } else if (data.type === "hmr-full-reload") {
        addLog("HMR boundary not found, reloading...", "info");
        if (lastBundleRef.current) {
          updateBundle(lastBundleRef.current);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Watch mode worker message handler
  useEffect(() => {
    if (!workerRef.current) return;

    const worker = workerRef.current;

    const watchHandler = (e: MessageEvent) => {
      const data = e.data;
      if (!data) return;

      if (data.type === "watch-ready") {
        setHmrReady(true);
        setBundling(false);
        lastBundleRef.current = data.code;
        setHasBundle(true);
        addLog("Watch build ready (initial)", "info");
        updateBundle(data.code);
      } else if (data.type === "hmr-update") {
        // Cache the full bundle for fallback
        lastBundleRef.current = data.bundle;
        setHasBundle(true);
        // Broadcast HMR update to all preview frames
        broadcastToFrames({
          type: "hmr-update",
          updatedModules: data.update.updatedModules,
          removedModules: data.update.removedModules,
        });
        addLog(
          "HMR: updated " +
            Object.keys(data.update.updatedModules).length +
            " module(s)",
          "info",
        );
      } else if (data.type === "watch-rebuild") {
        lastBundleRef.current = data.code;
        setHasBundle(true);
        addLog("Full rebuild (HMR not possible)", "info");
        updateBundle(data.code);
      } else if (data.type === "watch-stopped") {
        setHmrReady(false);
      } else if (data.type === "error" && watchMode) {
        addLog("Watch error: " + data.message, "error");
        setBundling(false);
      }
    };

    if (watchMode) {
      worker.onmessage = watchHandler;
    }
  }, [watchMode]);

  // Auto-scroll console
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [consoleOutput]);

  // Switch project
  useEffect(() => {
    if (!projects[currentProject]) return;
    const projectFiles = projects[currentProject];

    if (editorFSRef.current) {
      editorFSRef.current.replaceAll(projectFiles);
    } else {
      editorFSRef.current = new EditorFS(projectFiles);
    }
    setFileList(Object.keys(projectFiles));
    const entry = findEntryFile(projectFiles);
    setActiveFile(entry);
    setEditorValue(projectFiles[entry] || "");
    setConsoleOutput([]);
    window.history.replaceState(null, "", "?project=" + currentProject);

    if (watchMode) {
      stopWatch();
    }
  }, [currentProject, projects]);

  function addLog(text: string, type: string) {
    setConsoleOutput((prev) => [...prev, { text, type }]);
  }

  function findEntryFile(fileMap: FileMap): string {
    const candidates = ["/index.js", "/index.ts", "/index.tsx", "/index.jsx"];
    for (const c of candidates) {
      if (c in fileMap) return c;
    }
    return Object.keys(fileMap)[0] || "";
  }

  function switchTab(name: string) {
    setActiveFile(name);
    setEditorValue(editorFSRef.current?.read(name) || "");
  }

  function handleEditorChange(value: string) {
    setEditorValue(value);
    editorFSRef.current?.write(activeFile, value);
  }

  function handleEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = editorRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue =
        editorValue.substring(0, start) + "  " + editorValue.substring(end);
      handleEditorChange(newValue);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }
  }

  const handleRun = useCallback(async () => {
    const efs = editorFSRef.current;
    if (!efs) return;

    setConsoleOutput([]);
    setBundling(true);

    addLog("Bundling...", "info");

    try {
      if (!workerRef.current) {
        addLog("Worker not initialized", "error");
        return;
      }
      const bundleCode = await bundleInWorker(
        workerRef.current,
        efs.toFileMap(),
        window.location.origin,
      );

      lastBundleRef.current = bundleCode;
      setHasBundle(true);
      addLog("Bundle ready. Executing...", "info");
      updateBundle(bundleCode);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      addLog("Bundle error: " + message, "error");
    } finally {
      setBundling(false);
    }
  }, []);

  function startWatch() {
    const efs = editorFSRef.current;
    if (!efs || !workerRef.current) return;

    setConsoleOutput([]);
    setBundling(true);
    setWatchMode(true);

    efs.setWorker(workerRef.current);
    efs.setWatchMode(true);

    addLog("Starting watch mode...", "info");

    workerRef.current.postMessage({
      type: "watch-start",
      files: efs.toFileMap(),
      packageServerUrl: window.location.origin,
    });
  }

  function stopWatch() {
    const efs = editorFSRef.current;
    if (efs) {
      efs.setWatchMode(false);
      efs.setWorker(null);
    }

    if (workerRef.current) {
      workerRef.current.postMessage({ type: "watch-stop" });
    }
    setWatchMode(false);
    setHmrReady(false);
    lastBundleRef.current = "";
    setHasBundle(false);

    // Revoke blob URLs
    if (prevJsBlobUrlRef.current) {
      URL.revokeObjectURL(prevJsBlobUrlRef.current);
      prevJsBlobUrlRef.current = "";
    }
    if (prevBlobUrlRef.current) {
      URL.revokeObjectURL(prevBlobUrlRef.current);
      prevBlobUrlRef.current = "";
    }
    setBlobUrl("");

    addLog("Watch mode stopped", "info");

    // Re-create worker to reset its state and onmessage handler
    workerRef.current?.terminate();
    workerRef.current = new Worker(
      new URL("./bundler.worker.ts", import.meta.url),
      { type: "module" },
    );
  }

  function downloadBundle() {
    const code = lastBundleRef.current;
    if (!code) return;
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentProject + "-bundle.js";
    a.click();
    URL.revokeObjectURL(url);
  }

  const projectNames = Object.keys(projects);

  return (
    <>
      <header>
        <h1>ES Builder</h1>
        <div className="header-controls">
          {projectNames.length > 1 && (
            <select
              value={currentProject}
              onChange={(e) => setCurrentProject(e.target.value)}
            >
              {projectNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {watchMode ? (
            <button id="stop-btn" onClick={stopWatch}>
              Stop
            </button>
          ) : (
            <>
              <button id="run-btn" onClick={handleRun} disabled={bundling}>
                {bundling ? "Bundling..." : "Run"}
              </button>
              <button id="watch-btn" onClick={startWatch} disabled={bundling}>
                Watch
              </button>
            </>
          )}
          {hasBundle && (
            <button onClick={downloadBundle} title="Download bundle">
              Download
            </button>
          )}
        </div>
      </header>

      <div className="mobile-tabs">
        <button
          className={"mobile-tab" + (mobileTab === "editor" ? " active" : "")}
          onClick={() => setMobileTab("editor")}
        >
          Editor
        </button>
        <button
          className={"mobile-tab" + (mobileTab === "preview" ? " active" : "")}
          onClick={() => setMobileTab("preview")}
        >
          Preview
        </button>
        <button
          className={"mobile-tab" + (mobileTab === "console" ? " active" : "")}
          onClick={() => setMobileTab("console")}
        >
          Console
          {consoleOutput.length > 0 && (
            <span className="console-badge">{consoleOutput.length}</span>
          )}
        </button>
      </div>

      <div className="main">
        <div className={`editor-panel mobile-panel ${mobileTab === "editor" ? "mobile-active" : ""}`}>
          <div className="file-tabs">
            {fileList.map((name) => (
              <button
                key={name}
                className={"file-tab" + (name === activeFile ? " active" : "")}
                onClick={() => switchTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <textarea
            ref={editorRef}
            id="editor"
            spellCheck={false}
            value={editorValue}
            onChange={(e) => handleEditorChange(e.target.value)}
            onKeyDown={handleEditorKeyDown}
          />
        </div>

        <div className={`preview-panel mobile-panel ${mobileTab === "preview" ? "mobile-active" : ""}`}>
          <div className="panel-label">
            Preview
            {watchMode && hmrReady && (
              <span style={{ marginLeft: 8, fontSize: "0.8em", color: "#4caf50" }}>
                HMR active
              </span>
            )}
          </div>
          <div className="preview-frames">
            <PreviewFrame ref={frame1Ref} blobUrl={blobUrl} route="#/" />
            <PreviewFrame ref={frame2Ref} blobUrl={blobUrl} route="#/explore" />
          </div>
        </div>

        <div className={`console-panel mobile-panel ${mobileTab === "console" ? "mobile-active" : ""}`}>
          <div className="panel-label">Console</div>
          <div id="console-output" ref={consoleRef}>
            {consoleOutput.map((entry, i) =>
              entry.error ? (
                <div key={i} className="error-entry">
                  <div className="error-message">{entry.error.message}</div>
                  {entry.error.file && entry.error.line != null && (
                    <div className="error-location">
                      {entry.error.file}:{entry.error.line}
                      {entry.error.column != null ? ":" + entry.error.column : ""}
                    </div>
                  )}
                  {entry.error.stack.length > 0 && (
                    <div className="error-stack">
                      {entry.error.stack.map((frame, j) => (
                        <div key={j} className="stack-frame">
                          at {frame.fn} ({frame.file}:{frame.line}:{frame.column})
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className={"log-" + entry.type}>
                  {entry.text}
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </>
  );
}
