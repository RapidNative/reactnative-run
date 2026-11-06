import type { BundlerPlugin } from "browser-metro";

/**
 * Expo DOM components: a file whose directive prologue holds `"use dom"`
 * renders its (web) code inside a WebView on iOS/Android.
 *
 * This mirrors what Expo's own toolchain does, so expo/dom's runtime pieces
 * (the WebView wrapper in the native bundle, registerDOMComponent and the
 * props bridge in the web bundle) work unchanged:
 *
 *  - Native bundle: babel-preset-expo's use-dom-directive plugin replaces the
 *    module with a proxy component that renders `expo/dom/internal`'s WebView
 *    with a `filePath`. The wrapper loads `<dev server>/_expo/@dom/<filePath>`
 *    (expo/src/dom/base.ts: getBaseURL) and marshals props: JSON values as
 *    initial props / `$$props` messages, functions as actions over
 *    postMessage. createUseDomNativePlugin below emits the same proxy.
 *  - Dev server: @expo/cli's DomComponentsMiddleware answers
 *    `/_expo/@dom/<name>?file=<file URL>` with an HTML page that reads the
 *    WebView's injected object and loads a WEB bundle whose entry is
 *    `require('expo/dom/internal').registerDOMComponent(require(<file>).default)`
 *    (@expo/metro-config's transform worker generates that entry). rnrun's
 *    side of this is server/routes/dom.ts + DomComponentSessions.
 *
 * The file URL rnrun puts in `?file=` is the module's VFS path
 * (`file:///components/Chart.dom.tsx`), not its disk path: the native bundle
 * then doesn't depend on where the project sits on disk (the bundle cache key
 * covers project files, not the root), and the server only has to look the
 * path up in the VFS.
 */

/** Bumped whenever the proxy source changes, so cached native bundles miss. */
export const DOM_PROXY_VERSION = "1";

/** Where Expo's WebView wrapper loads DOM components from (base.ts). */
export const DOM_PAGE_PREFIX = "/_expo/@dom";
/** The web bundle a DOM page loads (rnrun's own path; only the page names it). */
export const DOM_BUNDLE_PREFIX = "/__rnrun/dom-bundle/";
/** Server-sent events: a DOM page reloads when its bundle changed. */
export const DOM_EVENTS_PATH = "/__rnrun/dom-events";
/** The synthetic web entry a DOM component's bundle is built from. */
export const DOM_ENTRY_PATH = "/__expo_dom_entry.js";

const SOURCE_RE = /\.[cm]?[jt]sx?$/;

/**
 * True when the source's directive prologue contains `"use dom"` -- what
 * babel-preset-expo checks (`program.directives`). Leading comments, a hashbang
 * and other directives ("use client", "use strict") may come first; any other
 * statement ends the prologue.
 */
export function hasUseDomDirective(src: string): boolean {
  let i = 0;
  const n = src.length;
  if (src.startsWith("#!")) {
    i = src.indexOf("\n");
    if (i === -1) return false;
  }
  for (;;) {
    // whitespace and comments
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith("//", i)) {
        const e = src.indexOf("\n", i);
        i = e === -1 ? n : e + 1;
      } else if (src.startsWith("/*", i)) {
        const e = src.indexOf("*/", i + 2);
        if (e === -1) return false;
        i = e + 2;
      } else break;
    }
    const q = src[i];
    if (q !== '"' && q !== "'") return false;
    const end = src.indexOf(q, i + 1);
    if (end === -1) return false;
    const value = src.slice(i + 1, end);
    if (/[\n\\]/.test(value)) return false;
    i = end + 1;
    // A directive is a whole expression statement: `"use dom";` or `"use dom"` + newline.
    // `"use dom" + x` or `"a".length` is an expression, which ends the prologue.
    let j = i;
    while (j < n && (src[j] === " " || src[j] === "\t")) j++;
    const next = src[j];
    const terminated = next === ";" || next === "\n" || next === "\r" || j >= n || src.startsWith("//", j) || src.startsWith("/*", j);
    if (!terminated) return false;
    if (value === "use dom") return true;
    i = next === ";" ? j + 1 : j;
  }
}

/** A local source file (not a package) that could be a DOM component. */
export function isDomComponentCandidate(path: string): boolean {
  return path.startsWith("/") && !path.includes("/node_modules/") && SOURCE_RE.test(path);
}

/** `file:///components/Chart.dom.tsx` for the VFS path `/components/Chart.dom.tsx`. */
export function domFileUrl(vfsPath: string): string {
  return "file://" + vfsPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * The VFS path a `?file=` value names, or null. Accepts rnrun's own file URLs
 * and, for a bundle made by Expo's toolchain against the same tree, an absolute
 * disk path under `rootDir`.
 */
export function vfsPathFromFileParam(file: string | null, rootDir?: string): string | null {
  if (!file || !file.startsWith("file://")) return null;
  let p: string;
  try {
    p = decodeURIComponent(file.slice("file://".length));
  } catch {
    return null;
  }
  if (!p.startsWith("/")) return null;
  if (rootDir) {
    const root = rootDir.replace(/\/+$/, "");
    if (p.startsWith(root + "/")) p = p.slice(root.length);
  }
  // No traversal: VFS paths are normalised, and anything else is not ours.
  if (p.split("/").some((s) => s === ".." || s === ".")) return null;
  return p;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** What babel-preset-expo names the proxy: the default-exported function's name. */
function displayNameOf(src: string): string {
  const m = /export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(src);
  return m ? m[1] : "Component";
}

/**
 * The checks babel-preset-expo makes, with its messages: one default export,
 * no other value exports, not a layout or API route.
 */
function assertDomModule(src: string, vfsPath: string): void {
  const name = basename(vfsPath);
  const fail = (msg: string) => {
    throw new Error(`${vfsPath}: ${msg}`);
  };
  if (/^_layout\.[jt]sx?$/.test(name)) {
    fail("Layout routes cannot be marked as DOM components because they cannot render native views.");
  }
  if (/\+api\.[jt]sx?$/.test(name)) fail("API routes cannot be marked as DOM components.");
  // Comments and strings could hold "export" text; strip the cheap cases.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (!/(^|[\s;])export\s+default\b/.test(code)) {
    fail('The "use dom" directive requires a default export to be present in the file.');
  }
  const named = /(^|[\s;])export\s+(?!default\b|type\b|interface\b|declare\b)(?:\{|\*|const\b|let\b|var\b|function\b|async\b|class\b|enum\b|abstract\b)/;
  if (named.test(code)) fail('Modules with the "use dom" directive only support a single default export.');
}

/**
 * The proxy module babel-preset-expo emits in development, apart from the file
 * URL (see the module comment) and the page's origin: rnrun's dev client
 * records the server the bundle came from, and the proxy names the page there
 * (`dom.overrideUri`, which expo/dom's WebView honours). expo/dom would derive
 * the same URL from the bundle's script URL -- except in Expo Go's anonymous
 * mode (iOS on hosted previews), where the bundle runs from Expo Go's update
 * cache and the script URL is a file, so expo/dom falls back to
 * http://localhost:8081.
 */
export function domProxySource(vfsPath: string, src: string): string {
  const filePath = `${basename(vfsPath)}?file=${domFileUrl(vfsPath)}`;
  return [
    'import React from "react";',
    'import { WebView } from "expo/dom/internal";',
    `const filePath = ${JSON.stringify(filePath)};`,
    "const _Expo_DOMProxyComponent = React.forwardRef((props, ref) => {",
    "  // rnrun: name the page on the server the bundle came from (set by rnrun's dev",
    "  // client). expo/dom derives it from the script URL, which is a cached file in",
    "  // Expo Go's anonymous (expo-updates) mode.",
    "  const origin = globalThis.__rnrunDevServerOrigin;",
    "  const given = props.dom;",
    "  const dom = React.useMemo(",
    "    () => (origin && !(given && given.overrideUri) ? { ...given, overrideUri: origin + " + JSON.stringify(DOM_PAGE_PREFIX + "/") + " + filePath } : given),",
    "    [origin, given]",
    "  );",
    "  return React.createElement(WebView, { ref, ...props, dom, filePath });",
    "});",
    `if (__DEV__) _Expo_DOMProxyComponent.displayName = ${JSON.stringify(`DOM(${displayNameOf(src)})`)};`,
    "export default _Expo_DOMProxyComponent;",
    "",
  ].join("\n");
}

/**
 * Native sessions: replace every "use dom" module with its WebView proxy,
 * before sucrase sees it -- so none of its imports (react-dom, a <canvas>
 * chart, global.css) reach the native bundle, which is the crash this fixes
 * ("View config getter callback for component `div` must be a function").
 */
export function createUseDomNativePlugin(): BundlerPlugin {
  return {
    name: "expo-use-dom-native",
    transformSource({ src, filename }) {
      if (!isDomComponentCandidate(filename) || !src.includes("use dom")) return null;
      if (!hasUseDomDirective(src)) return null;
      assertDomModule(src, filename);
      return { src: domProxySource(filename, src) };
    },
  };
}

/** The web entry for one DOM component (@expo/metro-config's transform worker). */
export function domEntrySource(vfsPath: string): string {
  return (
    "// Generated by rnrun: the web entry of the Expo DOM component " + vfsPath + ".\n" +
    `require("expo/dom/internal").registerDOMComponent(require(${JSON.stringify(vfsPath)}).default);\n`
  );
}

/** The project's DOM components, by VFS path. */
export function listDomComponents(files: Iterable<[string, string | undefined]>): string[] {
  const out: string[] = [];
  for (const [p, content] of files) {
    if (!content || !isDomComponentCandidate(p) || !content.includes("use dom")) continue;
    if (hasUseDomDirective(content)) out.push(p);
  }
  return out.sort();
}
