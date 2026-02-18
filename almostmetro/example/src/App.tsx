import { useState, useEffect, useRef, useCallback } from "react";
import type { FileMap } from "almostmetro";
import { EditorFS } from "./editor-fs";

interface Projects {
  [projectName: string]: FileMap;
}

interface ConsoleEntry {
  text: string;
  type: string;
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const editorFSRef = useRef<EditorFS | null>(null);
  const lastBundleRef = useRef<string>("");
  const [hasBundle, setHasBundle] = useState(false);

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

  // Listen for messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data) return;

      if (data.type === "console") {
        setConsoleOutput((prev) => [
          ...prev,
          { text: data.text, type: data.method === "log" ? "line" : data.method },
        ]);
      } else if (data.type === "hmr-full-reload") {
        addLog("HMR boundary not found, reloading...", "info");
        // Use the cached full bundle from the last hmr-update
        if (lastBundleRef.current) {
          executeInIframe(lastBundleRef.current);
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
        executeInIframe(data.code);
      } else if (data.type === "hmr-update") {
        // Cache the full bundle for fallback
        lastBundleRef.current = data.bundle;
        setHasBundle(true);
        // Forward HMR update to iframe
        const iframe = iframeRef.current;
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage(
            {
              type: "hmr-update",
              updatedModules: data.update.updatedModules,
              removedModules: data.update.removedModules,
            },
            "*",
          );
          addLog(
            "HMR: updated " +
              Object.keys(data.update.updatedModules).length +
              " module(s)",
            "info",
          );
        }
      } else if (data.type === "watch-rebuild") {
        lastBundleRef.current = data.code;
        setHasBundle(true);
        addLog("Full rebuild (HMR not possible)", "info");
        executeInIframe(data.code);
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
    // EditorFS already has the latest content for the old file
    // (written on every keystroke), so just read the new one
    setActiveFile(name);
    setEditorValue(editorFSRef.current?.read(name) || "");
  }

  function handleEditorChange(value: string) {
    setEditorValue(value);
    // Write immediately to EditorFS -- it debounces the worker sync
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
      executeInIframe(bundleCode);
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

  function executeInIframe(bundleCode: string) {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const container = iframe.parentNode as HTMLElement;
    const newFrame = document.createElement("iframe");
    newFrame.id = "preview-frame";
    newFrame.sandbox.add("allow-scripts");
    newFrame.sandbox.add("allow-same-origin");
    container.replaceChild(newFrame, iframe);
    iframeRef.current = newFrame as HTMLIFrameElement;

    const html =
      "<!DOCTYPE html><html><head><meta charset='UTF-8'><style>html,body,#root{height:100%;margin:0}body{overflow:hidden}#root{display:flex;flex-direction:column}</style></head><body><div id='root'></div><script>\n" +
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
      "});\n" +
      "window.onerror = function(msg, url, line, col, err) {\n" +
      "  window.parent.postMessage({ type: 'console', method: 'error', text: msg + ' (line ' + line + ')' }, '*');\n" +
      "};\n" +
      "</" +
      "script>\n" +
      "<script>\n" +
      bundleCode +
      "\n</" +
      "script>\n" +
      "</body></html>";

    const doc = (iframeRef.current as HTMLIFrameElement).contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
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
          <iframe
            ref={iframeRef}
            id="preview-frame"
            sandbox="allow-scripts allow-same-origin"
          />
        </div>

        <div className={`console-panel mobile-panel ${mobileTab === "console" ? "mobile-active" : ""}`}>
          <div className="panel-label">Console</div>
          <div id="console-output" ref={consoleRef}>
            {consoleOutput.map((entry, i) => (
              <div key={i} className={"log-" + entry.type}>
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
