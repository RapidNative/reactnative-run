import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import type { FileMap } from "browser-metro";
import { EditorFS } from "./editor-fs";
import { FileExplorer } from "./FileExplorer";
import { Play, Eye, Square, Download, Plus, RefreshCw, Terminal, Monitor, Sun, Moon, ChevronDown, FlaskConical, FolderTree, Code, Smartphone, Settings, Hammer, Info } from "lucide-react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Panel, Group as PanelGroup, Separator } from "react-resizable-panels";
import { configureTypeScript, syncFilesToMonaco } from "./monaco-ts-setup";

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

interface BundleResult {
  code: string;
  apiBundle: string | null;
}

function bundleInWorker(
  worker: Worker,
  files: FileMap,
  packageServerUrl: string,
  projectName?: string,
  assetBaseUrl?: string,
): Promise<BundleResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "result") {
        resolve({ code: e.data.code, apiBundle: e.data.apiBundle || null });
      } else if (e.data.type === "error") {
        reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ files, packageServerUrl, projectName, assetBaseUrl });
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
        className="flex-1 border-0 bg-white min-w-0"
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

function extractTailwindConfig(tailwindConfigContent: string): string {
  try {
    // Find module.exports = {...}
    let configString = "";
    const moduleExportsIndex = tailwindConfigContent.indexOf("module.exports");
    if (moduleExportsIndex !== -1) {
      const braceIndex = tailwindConfigContent.indexOf("{", moduleExportsIndex);
      if (braceIndex !== -1) {
        let depth = 0;
        let inString = false;
        let stringChar = "";
        for (let i = braceIndex; i < tailwindConfigContent.length; i++) {
          const char = tailwindConfigContent[i];
          const prevChar = i > 0 ? tailwindConfigContent[i - 1] : "";
          if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
            if (!inString) { inString = true; stringChar = char; }
            else if (char === stringChar) { inString = false; stringChar = ""; }
            continue;
          }
          if (inString) continue;
          if (char === "{") depth++;
          else if (char === "}") { depth--; if (depth === 0) { configString = tailwindConfigContent.substring(braceIndex, i + 1); break; } }
        }
      }
    }
    if (!configString) return "";
    // Clean up require() and process.env
    const cleaned = configString
      .replace(/require\([^)]*\)/g, "[]")
      .replace(/process\.env\.[A-Z_]+/g, '"class"')
      .replace(/:\s*undefined/g, ": null");
    // eslint-disable-next-line no-eval
    const configObj = eval("(" + cleaned + ")");
    const extend = configObj?.theme?.extend;
    if (!extend) return "";
    return "tailwind.config={darkMode:'class',theme:{extend:" + JSON.stringify(extend) + "}};";
  } catch {
    return "";
  }
}

function buildBundleHtml(
  jsBlobUrl: string,
  sourceMap: { sources: string[]; mappings: string } | null,
  tailwindConfigScript?: string,
  apiBlobUrl?: string,
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

  // API routes: load the API bundle and inject fetch interceptor
  let apiScripts = "";
  if (apiBlobUrl) {
    apiScripts =
      '<script src="' + apiBlobUrl + '"></' + "script>\n" +
      "<script>\n" +
      "(function() {\n" +
      "  var api = window.__API_ROUTES__;\n" +
      "  if (!api) return;\n" +
      "  var _origFetch = window.fetch;\n" +
      "  window.fetch = function(input, init) {\n" +
      "    var url = typeof input === 'string' ? input : input.url;\n" +
      "    var pathname = url;\n" +
      "    if (url.indexOf('://') !== -1) {\n" +
      "      try { pathname = new URL(url).pathname; } catch(e) {}\n" +
      "    } else if (url.indexOf('?') !== -1) {\n" +
      "      pathname = url.split('?')[0];\n" +
      "    }\n" +
      "    if (!api) return _origFetch.apply(this, arguments);\n" +
      "    var match = api.match(pathname);\n" +
      "    if (!match) return _origFetch.apply(this, arguments);\n" +
      "    var method = ((init && init.method) || 'GET').toUpperCase();\n" +
      "    var handler = match.handler[method];\n" +
      "    if (!handler) return Promise.resolve(new Response('Method not allowed', { status: 405 }));\n" +
      "    var request = new Request('http://localhost' + pathname, init);\n" +
      "    try {\n" +
      "      var result = handler(request);\n" +
      "      return result instanceof Promise ? result : Promise.resolve(result);\n" +
      "    } catch(err) {\n" +
      "      return Promise.resolve(new Response(JSON.stringify({ error: err.message }), { status: 500 }));\n" +
      "    }\n" +
      "  };\n" +
      "})();\n" +
      "</" + "script>\n";
  }

  return (
    "<!DOCTYPE html><html><head><meta charset='UTF-8'>" +
    "<script src='https://cdn.tailwindcss.com'></" + "script>" +
    (tailwindConfigScript ? "<script>" + tailwindConfigScript + "</" + "script>" : "") +
    "<style>html,body,#root{height:100%;margin:0}body{overflow:hidden}#root{display:flex;flex-direction:column}::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#3f3f46;border-radius:4px}::-webkit-scrollbar-thumb:hover{background:#52525b}::-webkit-scrollbar-corner{background:transparent}*{scrollbar-color:#3f3f46 transparent}</style></head><body><div id='root'></div><script>\n" +
    consoleScript +
    smResolverScript +
    "</" +
    "script>\n" +
    smInitScript +
    apiScripts +
    '<script src="' +
    jsBlobUrl +
    '"></' +
    "script>\n" +
    "</body></html>"
  );
}

// --- Main App ---

type MobileTab = "explorer" | "editor" | "preview";

const PACKAGE_SERVER_URL = import.meta.env.VITE_PACKAGE_SERVER_URL || window.location.origin;
const ASSET_BASE_URL = window.location.origin + import.meta.env.BASE_URL;

export function App() {
  const [projects, setProjects] = useState<Projects>({});
  const [currentProject, setCurrentProject] = useState("expo");
  const [fileList, setFileList] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [editorValue, setEditorValue] = useState("");
  const [consoleOutput, setConsoleOutput] = useState<ConsoleEntry[]>([]);
  const [bundling, setBundling] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("preview");
  const [watchMode, setWatchMode] = useState(false);
  const [hmrReady, setHmrReady] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const startWatchRef = useRef<(() => void) | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const editorFSRef = useRef<EditorFS | null>(null);
  const lastBundleRef = useRef<string>("");
  const lastApiBundleRef = useRef<string | null>(null);
  const prevApiBlobUrlRef = useRef("");
  const tailwindConfigRef = useRef<string>("");
  const [hasBundle, setHasBundle] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [hmrMenuOpen, setHmrMenuOpen] = useState(false);
  const [dualPreview, setDualPreview] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [isMobile, setIsMobile] = useState(window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

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

  function updateBundle(bundleCode: string, apiBundle?: string | null) {
    if (prevJsBlobUrlRef.current) URL.revokeObjectURL(prevJsBlobUrlRef.current);
    if (prevBlobUrlRef.current) URL.revokeObjectURL(prevBlobUrlRef.current);
    if (prevApiBlobUrlRef.current) URL.revokeObjectURL(prevApiBlobUrlRef.current);

    const jsBlob = new Blob([bundleCode], { type: "application/javascript" });
    const jsUrl = URL.createObjectURL(jsBlob);
    prevJsBlobUrlRef.current = jsUrl;

    // Build API blob URL if we have an API bundle
    let apiBlobUrl: string | undefined;
    const effectiveApiBundle = apiBundle !== undefined ? apiBundle : lastApiBundleRef.current;
    if (effectiveApiBundle) {
      const apiBlob = new Blob([effectiveApiBundle], { type: "application/javascript" });
      apiBlobUrl = URL.createObjectURL(apiBlob);
      prevApiBlobUrlRef.current = apiBlobUrl;
    } else {
      prevApiBlobUrlRef.current = "";
    }

    const sm = extractInlineSourceMap(bundleCode);
    const html = buildBundleHtml(jsUrl, sm, tailwindConfigRef.current, apiBlobUrl);
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
    fetch(import.meta.env.BASE_URL + "projects.json")
      .then((res) => res.json())
      .then((data: Projects) => {
        setProjects(data);
        const params = new URLSearchParams(window.location.search);
        const project = params.get("project") || "expo";
        setCurrentProject(project);
        const projectFiles = data[project];
        if (projectFiles) {
          editorFSRef.current = new EditorFS(projectFiles);
          setFileList(Object.keys(projectFiles));
          const defaultFile = findDefaultEditorFile(projectFiles);
          setActiveFile(defaultFile);
          setEditorValue(projectFiles[defaultFile]?.content || "");
          // Extract tailwind config from project files
          const twConfig = projectFiles["/tailwind.config.js"]?.content || projectFiles["/tailwind.config.ts"]?.content;
          if (twConfig) {
            tailwindConfigRef.current = extractTailwindConfig(twConfig);
          }
          // Auto-start watch mode (delay to let worker initialize)
          setTimeout(() => startWatchRef.current?.(), 500);
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
        if (data.apiBundle !== undefined) lastApiBundleRef.current = data.apiBundle;
        setHasBundle(true);
        addLog("Watch build ready (initial)" + (data.apiBundle ? " + API routes" : ""), "info");
        updateBundle(data.code, data.apiBundle);
      } else if (data.type === "hmr-update") {
        // Cache the full bundle for fallback
        lastBundleRef.current = data.bundle;
        setHasBundle(true);
        // If API bundle changed, do a full reload with updated API
        if (data.apiBundle) {
          lastApiBundleRef.current = data.apiBundle;
          addLog("API routes updated, reloading preview", "info");
          updateBundle(data.bundle, data.apiBundle);
          return;
        }
        // Broadcast HMR update to all preview frames
        broadcastToFrames({
          type: "hmr-update",
          updatedModules: data.update.updatedModules,
          removedModules: data.update.removedModules,
          reverseDepsMap: data.update.reverseDepsMap,
        });
        addLog(
          "HMR: updated " +
            Object.keys(data.update.updatedModules).length +
            " module(s)",
          "info",
        );
      } else if (data.type === "watch-rebuild") {
        lastBundleRef.current = data.code;
        if (data.apiBundle !== undefined) lastApiBundleRef.current = data.apiBundle;
        setHasBundle(true);
        addLog("Full rebuild (HMR not possible)" + (data.apiBundle ? " + API routes" : ""), "info");
        updateBundle(data.code, data.apiBundle);
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
    const defaultFile = findDefaultEditorFile(projectFiles);
    setActiveFile(defaultFile);
    setEditorValue(projectFiles[defaultFile]?.content || "");
    setConsoleOutput([]);
    window.history.replaceState(null, "", "?project=" + currentProject);

    if (monacoRef.current) {
      syncFilesToMonaco(monacoRef.current, projectFiles);
    }

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

  function findDefaultEditorFile(fileMap: FileMap): string {
    const preferred = [
      "/app/(tabs)/index.tsx",
      "/app/(tabs)/index.ts",
      "/app/(tabs)/index.jsx",
      "/app/(tabs)/index.js",
      "/App.tsx",
      "/App.ts",
      "/App.jsx",
      "/App.js",
      "/index.tsx",
      "/index.ts",
      "/index.jsx",
      "/index.js",
    ];
    for (const p of preferred) {
      if (p in fileMap) return p;
    }
    return Object.keys(fileMap)[0] || "";
  }

  function switchTab(name: string) {
    setActiveFile(name);
    setEditorValue(editorFSRef.current?.read(name) || "");
  }

  function mobileSelectFile(name: string) {
    switchTab(name);
    setMobileTab("editor");
  }

  function handleCreateFile(path: string, content: string) {
    const efs = editorFSRef.current;
    if (!efs) return;

    // Provide a default template for route files so Expo Router
    // doesn't encounter undefined exports before the user types content
    let fileContent = content;
    if (!fileContent && path.startsWith("/app/") && /\.(tsx|jsx)$/.test(path)) {
      const name = path.split("/").pop()?.replace(/\.\w+$/, "") || "Screen";
      const componentName = name.charAt(0).toUpperCase() + name.slice(1).replace(/[^a-zA-Z0-9]/g, "") + "Screen";
      fileContent = `import { View, Text, StyleSheet } from 'react-native';\n\nexport default function ${componentName}() {\n  return (\n    <View style={styles.container}>\n      <Text>${name}</Text>\n    </View>\n  );\n}\n\nconst styles = StyleSheet.create({\n  container: {\n    flex: 1,\n    alignItems: 'center',\n    justifyContent: 'center',\n  },\n});\n`;
    }

    efs.write(path, fileContent);
    setFileList(efs.list());
    switchTab(path);
    setEditorValue(fileContent);
  }

  function handleDeleteFile(path: string) {
    const efs = editorFSRef.current;
    if (!efs) return;
    efs.delete(path);
    setFileList(efs.list());
    if (activeFile === path) {
      const remaining = efs.list();
      if (remaining.length > 0) {
        switchTab(remaining[0]);
      }
    }
  }

  function handleEditorChange(value: string) {
    setEditorValue(value);
    editorFSRef.current?.write(activeFile, value);
  }

  function getMonacoLanguage(filename: string): string {
    if (filename.endsWith(".tsx") || filename.endsWith(".jsx")) return "typescript";
    if (filename.endsWith(".ts")) return "typescript";
    if (filename.endsWith(".js")) return "javascript";
    if (filename.endsWith(".json")) return "json";
    if (filename.endsWith(".css")) return "css";
    if (filename.endsWith(".html")) return "html";
    return "plaintext";
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
      const { code: bundleCode, apiBundle } = await bundleInWorker(
        workerRef.current,
        efs.toFileMap(),
        PACKAGE_SERVER_URL,
        currentProject,
        ASSET_BASE_URL,
      );

      lastBundleRef.current = bundleCode;
      lastApiBundleRef.current = apiBundle;
      setHasBundle(true);
      addLog("Bundle ready. Executing..." + (apiBundle ? " (+ API routes)" : ""), "info");
      updateBundle(bundleCode, apiBundle);
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
      packageServerUrl: PACKAGE_SERVER_URL,
      projectName: currentProject,
      assetBaseUrl: ASSET_BASE_URL,
    });
  }
  startWatchRef.current = startWatch;

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
    lastApiBundleRef.current = null;
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
    if (prevApiBlobUrlRef.current) {
      URL.revokeObjectURL(prevApiBlobUrlRef.current);
      prevApiBlobUrlRef.current = "";
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

  // --- HMR test: dynamically add a third tab to expo ---

  const settingsTabContent = `import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function SettingsScreen() {
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Settings</ThemedText>
      <ThemedText>This tab was added dynamically to test HMR!</ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 12,
  },
});
`;

  const updatedTabLayoutContent = `import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="api-test"
        options={{
          title: 'API Test',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="network" color={color} />,
        }}
      />
      <Tabs.Screen
        name="error"
        options={{
          title: 'Error',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="exclamationmark.triangle.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="gearshape.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
`;

  function addSettingsTab() {
    const efs = editorFSRef.current;
    if (!efs) return;
    efs.write("/app/(tabs)/settings.tsx", settingsTabContent);
    setFileList(efs.list());
    addLog("Added /app/(tabs)/settings.tsx", "info");
  }

  function updateTabLayout() {
    const efs = editorFSRef.current;
    if (!efs) return;
    efs.write("/app/(tabs)/_layout.tsx", updatedTabLayoutContent);
    // If the layout file is currently open in the editor, refresh it
    if (activeFile === "/app/(tabs)/_layout.tsx") {
      setEditorValue(updatedTabLayoutContent);
    }
    addLog("Updated /app/(tabs)/_layout.tsx with Settings tab", "info");
  }

  const isExpoReal = currentProject === "expo";

  return (
    <div className={`flex flex-col h-screen font-sans ${theme === "dark" ? "theme-dark bg-zinc-950 text-zinc-300" : "bg-white text-zinc-800"}`}>
      {/* Header */}
      <header className={`flex items-center gap-2 px-2 md:px-4 py-2 border-b shrink-0 relative z-50 ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              const target = window.parent !== window ? window.parent : window;
              target.location.href = "/";
            }}
            className="flex items-center gap-2 cursor-pointer"
          >
            <img src={import.meta.env.BASE_URL + "logo.svg"} alt="logo" className="w-6 h-6" />
            <h1 className={`text-sm font-semibold ${theme === "dark" ? "text-white" : "text-zinc-900"}`}>
              reactnative.run
            </h1>
          </a>
          <a
            href="https://rapidnative.com?utm_source=reactnative.run&utm_medium=header&utm_campaign=playground"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-zinc-500 hover:text-zinc-400 transition-colors hidden md:inline"
          >
            by RapidNative
          </a>
          <div className="relative hidden md:block">
            <button
              onClick={() => setShowDisclaimer(!showDisclaimer)}
              className="text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <Info size={12} />
            </button>
            {showDisclaimer && (
              <div className={`absolute left-0 top-full mt-2 w-72 rounded-lg border shadow-xl z-50 p-3 text-xs leading-relaxed ${theme === "dark" ? "bg-zinc-900 border-zinc-700 text-zinc-400" : "bg-white border-zinc-200 text-zinc-600"}`}>
                This project is not affiliated with, endorsed by, or associated with Meta, Facebook, the React Native team, or the React Foundation. The domain name "reactnative.run" is simply a descriptive name for this tool. React Native is a trademark of Meta Platforms, Inc.
                <button
                  onClick={() => setShowDisclaimer(false)}
                  className="block mt-2 text-blue-400 hover:text-blue-300 text-[10px] font-medium"
                >
                  Got it
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          {projectNames.length > 1 && (
            <select
              value={currentProject}
              onChange={(e) => setCurrentProject(e.target.value)}
              className={`h-7 pl-3 pr-7 text-xs rounded outline-none cursor-pointer border shrink-0 hidden md:block appearance-none bg-[length:12px] bg-[position:right_8px_center] bg-no-repeat ${theme === "dark" ? "bg-zinc-800 text-zinc-300 border-zinc-700 hover:border-zinc-500" : "bg-white text-zinc-700 border-zinc-300 hover:border-zinc-400"}`}
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='${theme === "dark" ? "%23a1a1aa" : "%2371717a"}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}
            >
              {projectNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {watchMode ? (
            <button
              onClick={stopWatch}
              className="flex items-center gap-1.5 h-7 px-3 text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 rounded hover:bg-red-500/30 transition-colors"
            >
              <Square size={12} />
              <span className="hidden sm:inline">Stop</span>
            </button>
          ) : (
            <>
              <button
                onClick={startWatch}
                disabled={bundling}
                className="flex items-center gap-1.5 h-7 px-3 text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Play size={12} />
                <span className="hidden sm:inline">{bundling ? "Bundling..." : "Run & Watch"}</span>
              </button>
              <button
                onClick={handleRun}
                disabled={bundling}
                className={`flex items-center gap-1.5 h-7 px-3 text-xs font-medium rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors border ${theme === "dark" ? "text-zinc-400 hover:text-zinc-200 border-zinc-700 hover:border-zinc-500" : "text-zinc-500 hover:text-zinc-700 border-zinc-300 hover:border-zinc-400"}`}
              >
                <Hammer size={12} />
                <span className="hidden sm:inline">Build</span>
              </button>
            </>
          )}
          {hasBundle && (
            <button
              onClick={downloadBundle}
              title="Download bundle"
              className={`flex items-center h-7 px-2 text-xs rounded transition-colors border ${theme === "dark" ? "text-zinc-400 hover:text-zinc-200 border-zinc-700 hover:border-zinc-500" : "text-zinc-500 hover:text-zinc-700 border-zinc-300 hover:border-zinc-400"}`}
            >
              <Download size={12} />
            </button>
          )}
          {isExpoReal && watchMode && hmrReady && (
            <div className="relative">
              <button
                onClick={() => setHmrMenuOpen(!hmrMenuOpen)}
                className={`flex items-center gap-1.5 h-7 px-3 text-xs font-medium rounded transition-colors ${theme === "dark" ? "bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30" : "bg-purple-50 text-purple-600 border border-purple-200 hover:bg-purple-100"}`}
              >
                <FlaskConical size={12} />
                <span className="hidden sm:inline">Test HMR</span>
                <ChevronDown size={10} />
              </button>
              {hmrMenuOpen && (
                <div className={`absolute right-0 top-full mt-1 w-48 rounded-md border shadow-lg z-50 py-1 ${theme === "dark" ? "bg-zinc-900 border-zinc-700" : "bg-white border-zinc-200"}`}>
                  <button
                    onClick={() => { addSettingsTab(); setHmrMenuOpen(false); }}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${theme === "dark" ? "text-zinc-300 hover:bg-zinc-800" : "text-zinc-700 hover:bg-zinc-100"}`}
                  >
                    <Plus size={12} className="text-blue-400" />
                    Add Settings Tab
                  </button>
                  <button
                    onClick={() => { updateTabLayout(); setHmrMenuOpen(false); }}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${theme === "dark" ? "text-zinc-300 hover:bg-zinc-800" : "text-zinc-700 hover:bg-zinc-100"}`}
                  >
                    <RefreshCw size={12} className="text-emerald-400" />
                    Update Layout
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className={`flex items-center h-7 px-2 text-xs rounded transition-colors border ${theme === "dark" ? "text-zinc-400 hover:text-zinc-200 border-zinc-700 hover:border-zinc-500" : "text-zinc-500 hover:text-zinc-700 border-zinc-300 hover:border-zinc-400"}`}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
          </button>
        </div>
      </header>

      {/* Mobile tabs */}
      {isMobile && <div className={`flex border-b ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
        {([
          { id: "explorer" as const, label: "Files", icon: <FolderTree size={14} /> },
          { id: "editor" as const, label: "Code", icon: <Code size={14} /> },
          { id: "preview" as const, label: "Preview", icon: <Smartphone size={14} /> },
        ]).map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors ${mobileTab === tab.id ? "text-blue-400 border-blue-400" : "text-zinc-500 border-transparent"}`}
            onClick={() => setMobileTab(tab.id)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>}

      {/* Mobile layout */}
      {isMobile && <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile: Explorer */}
        {mobileTab === "explorer" && (
          <div className={`flex-1 overflow-y-auto ${theme === "dark" ? "bg-zinc-900/50" : "bg-zinc-50"}`}>
            <FileExplorer
              files={fileList}
              activeFile={activeFile}
              onSelect={mobileSelectFile}
              onCreateFile={handleCreateFile}
              onDeleteFile={handleDeleteFile}
              theme={theme}
            />
          </div>
        )}
        {/* Mobile: Editor */}
        {mobileTab === "editor" && (
          <div className="flex-1 flex flex-col">
            <div className={`px-3 py-1.5 text-[11px] text-zinc-500 border-b truncate ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
              {activeFile}
            </div>
            <Editor
              theme={theme === "dark" ? "vs-dark" : "light"}
              language={getMonacoLanguage(activeFile)}
              value={editorValue}
              onChange={(value) => handleEditorChange(value || "")}
              onMount={(editor, monaco) => {
                editorRef.current = editor;
                monacoRef.current = monaco;
                configureTypeScript(monaco);
                const efs = editorFSRef.current;
                if (efs) syncFilesToMonaco(monaco, efs.toFileMap());
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 1.6,
                tabSize: 2,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: "on",
                padding: { top: 8 },
              }}
            />
          </div>
        )}
        {/* Mobile: Preview (single iframe + console) */}
        {mobileTab === "preview" && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 flex min-h-0">
              <PreviewFrame ref={frame1Ref} blobUrl={blobUrl} route="#/" />
            </div>
            <div className={`h-32 shrink-0 flex flex-col border-t ${theme === "dark" ? "border-zinc-800" : "border-zinc-200"}`}>
              <div className={`flex items-center gap-2 px-3 py-1 text-[11px] text-zinc-500 border-b ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
                <Terminal size={12} />
                Console
              </div>
              <div
                ref={consoleRef}
                className={`flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed ${theme === "dark" ? "bg-zinc-950" : "bg-white"}`}
              >
                {consoleOutput.map((entry, i) => (
                  <div key={i} className={
                    entry.error ? "text-red-400 font-semibold" :
                    entry.type === "warn" ? "text-yellow-400" :
                    entry.type === "error" ? "text-red-400" :
                    entry.type === "info" ? "text-blue-400" : "text-zinc-300"
                  }>
                    {entry.error ? entry.error.message : entry.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>}

      {/* Desktop layout: 3 columns - Explorer | Editor+Console | Preview */}
      {!isMobile && <div className="flex-1 overflow-hidden flex">
      <PanelGroup orientation="horizontal" className="flex-1">
        {/* File explorer */}
        <Panel defaultSize={20} maxSize={250} className={`overflow-y-auto ${theme === "dark" ? "bg-zinc-900/50" : "bg-zinc-50"}`}>
          <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Explorer
          </div>
          <FileExplorer
            files={fileList}
            activeFile={activeFile}
            onSelect={switchTab}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            theme={theme}
          />
        </Panel>

        <Separator className={`w-px hover:w-1 cursor-col-resize transition-colors ${theme === "dark" ? "bg-zinc-800 hover:bg-blue-500 active:bg-blue-500" : "bg-zinc-200 hover:bg-blue-400 active:bg-blue-400"}`} />

        {/* Code editor + Console (vertical split) */}
        <Panel defaultSize={40}>
          <PanelGroup orientation="vertical">
            <Panel defaultSize={70} className="flex flex-col">
              <div className={`px-3 py-1.5 text-[11px] text-zinc-500 border-b truncate ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
                {activeFile}
              </div>
              <Editor
                theme={theme === "dark" ? "vs-dark" : "light"}
                language={getMonacoLanguage(activeFile)}
                value={editorValue}
                onChange={(value) => handleEditorChange(value || "")}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  monacoRef.current = monaco;
                  configureTypeScript(monaco);
                  const efs = editorFSRef.current;
                  if (efs) syncFilesToMonaco(monaco, efs.toFileMap());
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineHeight: 1.6,
                  tabSize: 2,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  wordWrap: "on",
                  padding: { top: 8 },
                }}
              />
            </Panel>

            <Separator className={`h-px hover:h-1 cursor-row-resize transition-colors ${theme === "dark" ? "bg-zinc-800 hover:bg-blue-500 active:bg-blue-500" : "bg-zinc-200 hover:bg-blue-400 active:bg-blue-400"}`} />

            {/* Console */}
            <Panel defaultSize={30} className="flex flex-col">
              <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500 border-b ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
                <Terminal size={12} />
                Console
              </div>
              <div
                ref={consoleRef}
                className={`flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed ${theme === "dark" ? "bg-zinc-950" : "bg-white"}`}
              >
                {consoleOutput.map((entry, i) =>
                  entry.error ? (
                    <div key={i} className="border-l-2 border-red-400 pl-2 py-0.5 my-0.5 bg-red-500/5">
                      <div className="text-red-400 font-semibold">{entry.error.message}</div>
                      {entry.error.file && entry.error.line != null && (
                        <div className="text-orange-400 text-[11px] mt-0.5">
                          {entry.error.file}:{entry.error.line}
                          {entry.error.column != null ? ":" + entry.error.column : ""}
                        </div>
                      )}
                      {entry.error.stack.length > 0 && (
                        <div className="mt-1">
                          {entry.error.stack.map((frame, j) => (
                            <div key={j} className="text-zinc-600 text-[11px] pl-3">
                              at {frame.fn} ({frame.file}:{frame.line}:{frame.column})
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={
                        entry.type === "warn"
                          ? "text-yellow-400"
                          : entry.type === "error"
                            ? "text-red-400"
                            : entry.type === "info"
                              ? "text-blue-400"
                              : "text-zinc-300"
                      }
                    >
                      {entry.text}
                    </div>
                  ),
                )}
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <Separator className={`w-px hover:w-1 cursor-col-resize transition-colors ${theme === "dark" ? "bg-zinc-800 hover:bg-blue-500 active:bg-blue-500" : "bg-zinc-200 hover:bg-blue-400 active:bg-blue-400"}`} />

        {/* Preview */}
        <Panel defaultSize={40} className="flex flex-col">
          <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500 border-b ${theme === "dark" ? "bg-zinc-900 border-zinc-800" : "bg-zinc-50 border-zinc-200"}`}>
            <Monitor size={12} />
            Preview
            {watchMode && hmrReady && (
              <span className="ml-1 text-emerald-400">HMR active</span>
            )}
            <div className="flex-1" />
            <button
              onClick={() => setDualPreview(!dualPreview)}
              title={dualPreview ? "Single preview" : "Dual preview (test multiple routes)"}
              className={`p-0.5 rounded transition-colors ${dualPreview ? "text-blue-400" : "text-zinc-600 hover:text-zinc-400"}`}
            >
              <Settings size={12} />
            </button>
          </div>
          <div className={`flex-1 flex min-h-0 ${dualPreview ? `gap-px ${theme === "dark" ? "bg-zinc-800" : "bg-zinc-200"}` : ""}`}>
            <PreviewFrame ref={frame1Ref} blobUrl={blobUrl} route="#/" />
            {dualPreview && <PreviewFrame ref={frame2Ref} blobUrl={blobUrl} route="#/explore" />}
          </div>
        </Panel>
      </PanelGroup>
      </div>}
    </div>
  );
}
