import { gzipSync } from "node:zlib";
import type { VirtualFS } from "browser-metro";

/**
 * nativewind support for native (metro-format) sessions.
 *
 * Metro-with-nativewind does two things we replicate:
 *  1. JSX goes through `nativewind`'s jsx-runtime (automatic runtime with
 *     jsxImportSource "nativewind") so className props reach css-interop --
 *     handled in the session's transformer config.
 *  2. The project's `.css` import compiles (tailwind → cssToReactNativeRuntime)
 *     into an `injectData(...)` module. The compile runs on the package server
 *     (POST /nativewind-css); this module builds the request and wraps the
 *     response into module source served via the bundler's virtualSource hook.
 */

/** Env override for testing an unreleased server endpoint. */
const NATIVEWIND_SERVER = process.env.RNRUN_NATIVEWIND_SERVER;

/**
 * The compile request carries every source file (tailwind's content scan), so
 * a mid-sized app easily exceeds 1MB uncompressed -- past the nginx default
 * `client_max_body_size` in front of the package server, which answers 413
 * before Express (10mb limit) ever sees the body. Source gzips ~5x, so the
 * body is sent compressed; Express' body parser inflates it transparently.
 */
export function encodeNativewindRequest(body: object): { bytes: Uint8Array; rawBytes: number } {
  const json = JSON.stringify(body);
  return { bytes: gzipSync(Buffer.from(json, "utf8")), rawBytes: Buffer.byteLength(json, "utf8") };
}

const CONTENT_EXT_RE = /\.(?:tsx?|jsx?|html|mdx)$/;
/** Also materialized on the server, though not scanned for classes: the
 *  config runs there with plain Node `require`, so a `require("./theme.json")`
 *  in tailwind.config.js needs the file in the workdir or the compile 500s
 *  ("Cannot find module './text-scale.json'") and the app gets no styles.
 *  Lockfiles are skipped -- they can be megabytes and no config reads them. */
const CONFIG_DATA_RE = /\.json$/;
const LOCKFILE_RE = /(?:^|\/)package-lock\.json$/;

/** Above this much source (raw bytes), the compile request carries each file's class candidates, not its text. */
export const CONTENT_REDUCE_ABOVE = 4_000_000;

/**
 * The content scan, smaller: each source file as its distinct whitespace-separated tokens, one per line, minus the
 * tokens an earlier file in the same top-level folder with the same extension already carries. A tailwind class never
 * contains whitespace, a double quote, a backtick or a brace, so splitting there (and dropping tokens without a
 * letter) loses no candidate, and every token stays at a path the config's content globs match (they go by folder
 * and extension). RingCode (Nov 2026, ~1,400 source files): 14.5MB raw, 2.7MB gzipped, over the package server's
 * limits (HTTP 413, every className unstyled on phones); reduced: 2.1MB raw, 0.74MB gzipped. Other files (the JSON a
 * config may require) go as they are.
 */
export function reduceTailwindContent(content: Record<string, string>): Record<string, string> {
  const seen = new Map<string, Set<string>>();
  const out: Record<string, string> = {};
  for (const p of Object.keys(content).sort()) {
    const src = content[p];
    if (!CONTENT_EXT_RE.test(p)) {
      out[p] = src;
      continue;
    }
    const key = `${p.split("/").filter(Boolean)[0] ?? ""}|${p.slice(p.lastIndexOf("."))}`;
    let set = seen.get(key);
    if (!set) seen.set(key, (set = new Set()));
    const tokens: string[] = [];
    for (const t of src.split(/[\s"`{}]+/)) {
      if (!t || !/[a-z]/i.test(t) || set.has(t)) continue;
      set.add(t);
      tokens.push(t);
    }
    out[p] = tokens.join("\n");
  }
  return out;
}

export interface NativewindDetection {
  enabled: boolean;
  reason?: string;
}

/** nativewind needs: nativewind + tailwindcss + react-native-css-interop declared, and a tailwind config. */
export function detectNativewind(vfs: VirtualFS): NativewindDetection {
  let deps: Record<string, string>;
  try {
    deps = JSON.parse(vfs.read("/package.json") || "{}").dependencies || {};
  } catch {
    return { enabled: false };
  }
  if (!("nativewind" in deps)) return { enabled: false };
  if (!vfs.exists("/tailwind.config.js")) {
    return { enabled: false, reason: "nativewind declared but no /tailwind.config.js found" };
  }
  if (!("tailwindcss" in deps)) {
    return { enabled: false, reason: "nativewind declared but tailwindcss is not in dependencies" };
  }
  if (!("react-native-css-interop" in deps)) {
    return {
      enabled: false,
      reason:
        "nativewind declared but react-native-css-interop is not in dependencies -- add it for native className support",
    };
  }
  return { enabled: true };
}

/** What a css file whose compile failed becomes: no styles, but the import still resolves. */
export function failedCssModule(cssPath: string): string {
  return `// rnrun: nativewind could not compile ${cssPath}; its styles are missing on this platform\nmodule.exports = {};`;
}

/**
 * Compile every project `.css` file to an injectData module.
 *
 * Returns a map of css path → module source, or null when nothing compiled
 * (callers keep the previous modules). Files compile independently: one the
 * server can't compile becomes an empty module (failedCssModule) and is listed
 * in `opts.failed`, and the rest keep their styles. Metro only compiles the css
 * a platform's graph imports, so a file that fails here is often one native
 * never loads -- a converted app's web-only stylesheet, imported by .web.tsx
 * and "use dom" files. When any failure used to drop every file's styles, the
 * app's global.css went with it and Expo Go showed a black screen: every
 * className unstyled, so flex-1 / min-h layouts collapsed to nothing (Full
 * Swing KIT, Nov 2026: css-interop's parseAspectRatio threw on src/lib/rn/source.css).
 */
export async function compileNativewindCss(opts: {
  vfs: VirtualFS;
  platform: string;
  packageServerUrl: string;
  fetch?: typeof fetch;
  warn: (msg: string) => void;
  /** Filled with the css paths that failed to compile (when some did). */
  failed?: string[];
}): Promise<Map<string, string> | null> {
  const { vfs, platform, warn } = opts;
  const doFetch = opts.fetch ?? fetch;
  const serverUrl = NATIVEWIND_SERVER || opts.packageServerUrl;

  const allPaths = vfs.list();
  const cssPaths = allPaths.filter((p) => p.endsWith(".css"));
  if (cssPaths.length === 0) return new Map();

  let deps: Record<string, string> = {};
  try {
    deps = JSON.parse(vfs.read("/package.json") || "{}").dependencies || {};
  } catch {
    /* handled below by missing versions */
  }
  const versions: Record<string, string> = {};
  // react-native-reanimated + worklets are sent so the server can precisely
  // gate its CSS-animation degrade (css-interop 0.2.x on reanimated 4 crashes).
  for (const name of ["nativewind", "tailwindcss", "react-native-css-interop", "react-native", "react-native-reanimated", "react-native-worklets"]) {
    if (deps[name]) versions[name] = deps[name];
  }

  const tailwindConfig = vfs.read("/tailwind.config.js");
  if (!tailwindConfig) return null;

  let content: Record<string, string> = {};
  let contentBytes = 0;
  for (const p of allPaths) {
    if (!CONTENT_EXT_RE.test(p) && !(CONFIG_DATA_RE.test(p) && !LOCKFILE_RE.test(p))) continue;
    const src = vfs.read(p);
    if (src) {
      content[p] = src;
      contentBytes += src.length;
    }
  }
  // a large app: its class candidates only (small apps keep the request, and the server's cached compile, as is)
  if (contentBytes > CONTENT_REDUCE_ABOVE) content = reduceTailwindContent(content);

  const result = new Map<string, string>();
  const failed: string[] = [];
  const fail = (cssPath: string, msg: string) => {
    warn(msg);
    failed.push(cssPath);
    result.set(cssPath, failedCssModule(cssPath));
  };
  for (const cssPath of cssPaths) {
    const css = vfs.read(cssPath);
    if (!css) {
      result.set(cssPath, "module.exports = {};");
      continue;
    }
    try {
      const { bytes, rawBytes } = encodeNativewindRequest({ platform, versions, tailwindConfig, css, content });
      const res = await doFetch(`${serverUrl}/nativewind-css`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: bytes,
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const size = res.status === 413 ? ` -- request body ${Math.round(bytes.length / 1024)}KB gzipped (${Math.round(rawBytes / 1024)}KB raw) rejected by the server` : "";
        const detail = await serverError(res);
        fail(
          cssPath,
          `[nativewind] [${platform}] compile failed for ${cssPath} (HTTP ${res.status}${size})${detail ? `: ${detail}` : ""}; ` +
            `className styles and darkMode flags will be missing on this platform wherever this file supplies them`
        );
        continue;
      }
      const { data } = (await res.json()) as { data: { web?: boolean; css?: string } };
      if (data?.web) {
        // Web: inject the compiled stylesheet into <head>. Idempotent per css
        // path so an HMR re-execution replaces the tag instead of stacking.
        result.set(
          cssPath,
          "(function(){" +
            'if (typeof document === "undefined") return;' +
            "var id = " + JSON.stringify("rnrun-nw:" + cssPath) + ";" +
            'var s = document.createElement("style");' +
            "s.id = id;" +
            "s.textContent = " + JSON.stringify(data.css ?? "") + ";" +
            "var prev = document.getElementById(id);" +
            "if (prev) prev.replaceWith(s); else document.head.appendChild(s);" +
            "})();\nmodule.exports = {};"
        );
      } else {
        result.set(
          cssPath,
          // injectData lives in css-interop's native runtime; requiring the
          // subpath shares the instance with the components' own chunk via the
          // combined-subpath machinery.
          'require("react-native-css-interop/dist/runtime/native/styles").injectData(' +
            JSON.stringify(data) +
            ");\nmodule.exports = {};"
        );
      }
    } catch (err) {
      fail(cssPath, `[nativewind] [${platform}] compile failed for ${cssPath} (${(err as Error).message}); its styles are missing on this platform`);
    }
  }
  opts.failed?.push(...failed);
  // Nothing compiled (server down, request too large): keep the previous modules.
  if (failed.length === cssPaths.length && failed.length > 0) return null;
  return result;
}

/** The first line of the server's error, for the warning. */
async function serverError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    let msg = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") msg = parsed.error;
    } catch {
      /* plain text */
    }
    const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
    // "Command failed: node runner.cjs ..." is noise; the error is the next line.
    const line = lines.find((l) => !/^Command failed:/.test(l)) ?? lines[0] ?? "";
    return line.slice(0, 200);
  } catch {
    return "";
  }
}
