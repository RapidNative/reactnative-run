import { VirtualFS } from "../fs.js";
import { Bundler } from "../bundler.js";
import type { BundlerConfig, ContentChange } from "../types.js";

/** File extensions that can be expo-router route modules or API route handlers. */
const ROUTE_EXTS = new Set(["tsx", "ts", "jsx", "js"]);

/**
 * Check if a file path is an API route (+api.ts/tsx/js/jsx).
 */
export function isApiRouteFile(filePath: string): boolean {
  return /\+api\.(ts|tsx|js|jsx)$/.test(filePath);
}

/**
 * Convert a file path like /app/api/hello+api.ts to a URL like /api/hello.
 * Supports dynamic segments: /app/api/users/[id]+api.ts -> /api/users/[id]
 * Supports index routes: /app/api/index+api.ts -> /api
 */
export function filePathToApiRoute(filePath: string): string {
  // Strip /app prefix and extension
  let route = filePath.slice("/app".length).replace(/\+api\.(tsx?|jsx?|js)$/, "");
  // Remove trailing slash
  if (route.endsWith("/")) route = route.slice(0, -1);
  // Handle index routes
  if (route.endsWith("/index")) route = route.slice(0, -"/index".length);
  return route || "/";
}

/**
 * Build the API routes entry module that maps URL paths to their handler modules.
 * Exports routes object and a match() function for URL matching.
 * Returns null when the project has no +api files.
 */
export function buildApiRoutesEntry(vfs: VirtualFS): string | null {
  const apiFiles: { filePath: string; urlPath: string }[] = [];

  for (const filePath of vfs.list()) {
    if (!filePath.startsWith("/app/")) continue;
    if (!isApiRouteFile(filePath)) continue;
    const ext = filePath.split(".").pop() || "";
    if (!ROUTE_EXTS.has(ext)) continue;
    apiFiles.push({
      filePath,
      urlPath: filePathToApiRoute(filePath),
    });
  }

  if (apiFiles.length === 0) return null;

  const routeEntries = apiFiles
    .map((r) => {
      const requirePath = "." + r.filePath.replace(/\.[^.]+$/, "");
      return `  "${r.urlPath}": require("${requirePath}"),`;
    })
    .join("\n");

  return `var routes = {
${routeEntries}
};

function match(pathname) {
  // Exact match first
  if (routes[pathname]) return { handler: routes[pathname], params: {} };
  // Dynamic segment matching
  var keys = Object.keys(routes);
  for (var i = 0; i < keys.length; i++) {
    var pattern = keys[i];
    if (pattern.indexOf("[") === -1) continue;
    var patternParts = pattern.split("/");
    var pathParts = pathname.split("/");
    if (patternParts.length !== pathParts.length) continue;
    var params = {};
    var matched = true;
    for (var j = 0; j < patternParts.length; j++) {
      if (patternParts[j].startsWith("[") && patternParts[j].endsWith("]")) {
        params[patternParts[j].slice(1, -1)] = pathParts[j];
      } else if (patternParts[j] !== pathParts[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: routes[pattern], params: params };
  }
  return null;
}

// Expose on window so the fetch interceptor can access it
if (typeof window !== "undefined") {
  window.__API_ROUTES__ = { routes: routes, match: match };
}
module.exports = { routes: routes, match: match };
`;
}

/**
 * Build the expo-router route context module (/__expo_ctx.js): a
 * require.context-like function mapping keys such as "./(tabs)/index.tsx"
 * to their modules. API route files are excluded -- they are bundled
 * separately (see buildApiRoutesEntry).
 *
 * Each route loads inside try/catch: a broken route throws when *navigated to*
 * (expo-router surfaces it per-screen) instead of taking down the whole app at
 * require time.
 */
export function buildExpoRouteContext(vfs: VirtualFS): string {
  const entries: { contextKey: string; requirePath: string }[] = [];
  // Track which directories under /app/ have route files and which have layouts
  const dirsWithRoutes = new Set<string>();
  const dirsWithLayouts = new Set<string>();

  for (const filePath of vfs.list()) {
    if (!filePath.startsWith("/app/")) continue;
    const ext = filePath.split(".").pop() || "";
    if (!ROUTE_EXTS.has(ext)) continue;
    // Exclude API route files from the client route context
    if (isApiRouteFile(filePath)) continue;

    // Track directory info for layout auto-generation
    const dir = filePath.slice(0, filePath.lastIndexOf("/") + 1); // e.g. "/app/settings/"
    dirsWithRoutes.add(dir);
    const basename = filePath.slice(dir.length).replace(/\.[^.]+$/, "");
    if (basename === "_layout") dirsWithLayouts.add(dir);

    // Context keys are relative to /app/ with "./" prefix, e.g. "./(tabs)/index.tsx"
    // Require paths are relative to project root, e.g. "./app/(tabs)/index"
    entries.push({
      contextKey: "./" + filePath.slice("/app/".length),
      requirePath: "." + filePath.replace(/\.[^.]+$/, ""),
    });
  }

  // Auto-generate default _layout files for directories that have route files
  // but no _layout. Without a layout, expo-router can't create the Route context
  // provider, causing "No filename found" errors at runtime.
  for (const dir of dirsWithRoutes) {
    if (dirsWithLayouts.has(dir)) continue;
    const layoutPath = dir + "_layout.tsx";
    const defaultLayout = `import { Slot } from "expo-router";\nexport default function Layout() { return <Slot />; }\n`;
    vfs.write(layoutPath, defaultLayout);
    const contextKey = "./" + layoutPath.slice("/app/".length);
    const requirePath = "." + layoutPath.replace(/\.[^.]+$/, "");
    entries.push({ contextKey, requirePath });
  }

  const loads = entries
    .map((e) => `  try { modules["${e.contextKey}"] = require("${e.requirePath}"); } catch(e) { moduleErrors["${e.contextKey}"] = e; }`)
    .join("\n");

  return `var modules = {};
var moduleErrors = {};
function ctx(id) { if (id in moduleErrors) throw moduleErrors[id]; return modules[id]; }
ctx.keys = function() { return Object.keys(modules).concat(Object.keys(moduleErrors)); };
module.exports = ctx;
${loads}
`;
}

/**
 * Build the synthetic entry that imports the route context and renders ExpoRoot.
 * This is a .tsx file so React Refresh instruments App with module.hot.accept(),
 * making it an HMR accept boundary for route context changes.
 *
 * Defensive: expo-router's ExpoRoot can be undefined when the package server's
 * esbuild bundle fails to initialize at runtime (e.g. a transitive dependency
 * wasn't resolved, or the IIFE threw during module evaluation leaving
 * module.exports as {}). We detect the missing export and show a clear
 * diagnostic instead of letting React crash with "Element type is invalid".
 */
export function buildExpoRouterEntry(): string {
  return `import { registerRootComponent } from "expo";
import React from "react";

var _expoRouter;
try { _expoRouter = require("expo-router"); } catch(e) {
  console.error("[expo-entry] Failed to load expo-router:", e);
}
var ExpoRoot = _expoRouter && _expoRouter.ExpoRoot;
if (!ExpoRoot) {
  var _keys = _expoRouter ? Object.keys(_expoRouter) : null;
  console.error("[expo-entry] ExpoRoot is " + (ExpoRoot === undefined ? "undefined" : "falsy") +
    ". expo-router exports: " + (_keys ? (_keys.length ? _keys.join(", ") : "(empty object — package chunk may be missing from bundle)") : "(module failed to load)"));
  if (_expoRouter && _keys && _keys.length === 0 && typeof globalThis !== "undefined" && globalThis.__BUNDLER_HMR__) {
    var _src = globalThis.__BUNDLER_HMR__.modules["expo-router"];
    console.error("[expo-entry] expo-router module source length:", _src ? _src.toString().length : "not in module map");
  }
}

const ctx = require("./__expo_ctx");

function App() {
  if (!ExpoRoot) {
    var RN = require("react-native");
    return React.createElement(RN.View, { style: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 } },
      React.createElement(RN.Text, { style: { color: "#e11d48", fontSize: 15, textAlign: "center", lineHeight: 22 } },
        "expo-router failed to initialize: ExpoRoot is undefined.\\n\\n" +
        "Available exports: " + (_expoRouter ? Object.keys(_expoRouter).join(", ") : "none") +
        "\\n\\nThis usually means a dependency of expo-router failed to load. Check the browser console for details.")
    );
  }
  return React.createElement(ExpoRoot, { context: ctx });
}

if (!globalThis.__EXPO_ROOT_REGISTERED) {
  registerRootComponent(App);
  globalThis.__EXPO_ROOT_REGISTERED = true;
}
`;
}

/**
 * Resolve the project's entry file, synthesizing the expo-router split entry
 * (/__expo_ctx.js route map + /index.tsx entry) when package.json main is
 * "expo-router/entry". Returns null when no entry can be determined.
 */
export function ensureEntryFile(vfs: VirtualFS): string | null {
  const entry = vfs.getEntryFile();
  if (entry) return entry;

  const main = vfs.getPackageMain();
  if (main === "expo-router/entry") {
    vfs.write("/__expo_ctx.js", buildExpoRouteContext(vfs));
    vfs.write("/index.tsx", buildExpoRouterEntry());
    return "/index.tsx";
  }

  return null;
}

/**
 * When route files under /app/ are added or removed, the route context module
 * must be regenerated so the module map includes the new routes. We regenerate
 * /__expo_ctx.js (not the entry) so HMR can propagate the change up to the
 * entry's App component without requiring a full reload.
 *
 * Writes the new context to the VFS and returns the corresponding change to
 * append to the rebuild's change list, or null when nothing needs regenerating.
 */
export function applyRouteStructureChanges(
  vfs: VirtualFS,
  changes: ContentChange[]
): ContentChange | null {
  if (vfs.getPackageMain() !== "expo-router/entry") return null;

  const hasRouteChange = changes.some((c) => {
    if (!c.path.startsWith("/app/")) return false;
    if (isApiRouteFile(c.path)) return false;
    const ext = c.path.split(".").pop() || "";
    if (!ROUTE_EXTS.has(ext)) return false;
    return c.type === "create" || c.type === "delete";
  });
  if (!hasRouteChange) return null;

  const newCtx = buildExpoRouteContext(vfs);
  vfs.write("/__expo_ctx.js", newCtx);
  return { path: "/__expo_ctx.js", type: "update", content: newCtx };
}

/**
 * Bundle the project's +api route handlers into a standalone bundle
 * (entry /__api_routes.js). Returns null when the project has no API routes.
 * The caller provides the full BundlerConfig (plugins, sourceExts, server).
 */
export async function buildApiBundle(
  vfs: VirtualFS,
  config: BundlerConfig
): Promise<string | null> {
  const apiEntry = buildApiRoutesEntry(vfs);
  if (!apiEntry) return null;

  vfs.write("/__api_routes.js", apiEntry);

  const bundler = new Bundler(vfs, config);
  return await bundler.bundle("/__api_routes.js");
}
