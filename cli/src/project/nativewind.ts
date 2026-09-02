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

/**
 * Compile every project `.css` file to an injectData module.
 * Returns a map of css path → module source, or null on failure (callers keep
 * the previous modules).
 */
export async function compileNativewindCss(opts: {
  vfs: VirtualFS;
  platform: string;
  packageServerUrl: string;
  fetch?: typeof fetch;
  warn: (msg: string) => void;
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

  const content: Record<string, string> = {};
  for (const p of allPaths) {
    if (!CONTENT_EXT_RE.test(p)) continue;
    const src = vfs.read(p);
    if (src) content[p] = src;
  }

  const result = new Map<string, string>();
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
        warn(`[nativewind] compile failed for ${cssPath} (HTTP ${res.status}${size}); styles unchanged -- className styles and darkMode flags will be missing on this platform`);
        return null;
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
      warn(`[nativewind] compile failed for ${cssPath} (${(err as Error).message}); styles unchanged`);
      return null;
    }
  }
  return result;
}
