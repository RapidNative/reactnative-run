# Architecture

## Overview

almostmetro is a browser-based bundler that mirrors the architecture of Metro (React Native's bundler) in a simplified form. The system has three runtime components that work together:

```
Browser (example app)          almostesm (:5200)
+------------------------+     +---------------------+
| VirtualFS              |     | GET /pkg/:specifier  |
|   FileMap of sources   |     |   npm install        |
|                        |     |   esbuild bundle     |
| Bundler                |     |   cache to disk      |
|   1. Walk dep graph    |     +---------------------+
|   2. Transform files   |            ^
|   3. Rewrite requires  |            |
|   4. Fetch npm pkgs ---+---> fetch /pkg/lodash
|   5. Emit bundle       |
|                        |
| Execute in iframe      |
+------------------------+
```

## Data Flow

### 1. Project Loading

The example app loads `projects.json` (generated at build time from `user_projects/` on disk) into memory. Each project is a `FileMap` - a flat object mapping absolute paths to source strings:

```typescript
{
  "/index.ts": "import { greet } from './utils';\n...",
  "/utils.ts": "export function greet(name: string) {...}",
  "/package.json": "{ \"dependencies\": {} }"
}
```

### 2. Virtual Filesystem

`VirtualFS` wraps a `FileMap` with filesystem operations (read, write, exists, list). The bundler never touches the real filesystem - everything operates on this in-memory map. This makes the system portable: the same bundler runs in the browser, in tests, or on a server.

### 3. Module Resolution

The `Resolver` implements Node.js-style module resolution against the VirtualFS:

1. **Relative imports** (`./utils`, `../lib/foo`) - resolved against the importing file's directory
2. **Extension resolution** - tries each extension in `sourceExts` (e.g. `.ts`, `.tsx`, `.js`, `.jsx`)
3. **Index files** - tries `dir/index.{ext}` for directory imports
4. **npm packages** - anything not starting with `.` or `/` is treated as an npm package

The `sourceExts` config makes extension resolution dynamic. Adding `"svelte"` to sourceExts would make the resolver find `.svelte` files without any other changes.

### 4. Transformation & Plugin Pipeline

Each file passes through a three-stage pipeline before being added to the bundle:

```
   Original source (.tsx/.ts/.jsx/.js)
              │
              ▼
   ┌──────────────────────┐
   │  Pre-transform hooks │  BundlerPlugin.transformSource()
   │  (JSX still intact)  │  e.g. data-bx-path injection
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Core transform      │  Transformer.transform()
   │  (Sucrase)           │  TS types stripped, JSX → createElement, ESM → CJS
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Post-transform hooks│  BundlerPlugin.transformOutput()
   │  (CommonJS output)   │  e.g. React Refresh registration
   └──────────────────────┘
```

The default `typescriptTransformer` uses sucrase:

- `.ts` files: strip TypeScript types, convert ES imports to CommonJS
- `.tsx` files: strip TypeScript types, convert JSX, convert imports
- `.jsx` files: convert JSX, convert imports
- `.js` files: convert ES imports to CommonJS

The `reactRefreshTransformer` extends the default with React Refresh registration code (wraps each component with `$RefreshReg$` and `$RefreshSig$` calls, and appends a `module.hot.accept()` postamble).

#### Plugin System

Plugins implement the `BundlerPlugin` interface and can hook into multiple stages:

| Hook | Phase | Use Case |
|---|---|---|
| `transformSource` | Before Sucrase | Modify raw JSX/TS source (e.g. inject attributes) |
| `transformOutput` | After Sucrase | Modify CJS output (e.g. add instrumentation) |
| `resolveRequest` | Module resolution | Custom resolution logic (return resolved path or null) |
| `moduleAliases` | Pre-fetch | Redirect `require("A")` to package B |
| `shimModules` | Pre-fetch | Replace npm packages with inline code |

**Plugin ordering matters**: plugins run in array order. For example, `dataBxPathPlugin` must come before `expoWebPlugin` because it operates on original source with correct line numbers (before any lines are prepended).

#### Source Map Adjustments

When plugins add or remove lines, the source maps are automatically adjusted:

- **Pre-transform plugins** (e.g. `data-bx-path` injects inline attributes): Sucrase generates a source map pointing to the plugin-modified source, so `shiftSourceMapOrigLines()` shifts original-line references back by the number of added lines.
- **Post-transform plugins** (e.g. React Refresh prepends registration code): Empty mapping lines (`;`) are prepended to skip over the added output lines.

### 5. Bundle Generation

The bundler walks the dependency graph starting from the entry file:

1. **Walk** - recursively follow `require()` calls, transforming each file
2. **Collect npm packages** - track any require targets that are npm packages
3. **Fetch packages** - download pre-bundled npm packages from almostesm in parallel
4. **Emit** - produce a single self-executing bundle:

```javascript
(function(modules) {
  var cache = {};
  function require(id) {
    if (cache[id]) return cache[id].exports;
    var module = cache[id] = { exports: {} };
    modules[id].call(module.exports, module, module.exports, require);
    return module.exports;
  }
  require("/index.ts");
})({
  "/index.ts": function(module, exports, require) { /* transformed source */ },
  "/utils.ts": function(module, exports, require) { /* transformed source */ },
  "react": function(module, exports, require) { /* pre-bundled from server */ },
});
```

### 6. Bundle Preamble & Environment Variables

Every emitted bundle is prefixed with a **preamble** that sets up the `process` global, so npm packages that check `process.env.NODE_ENV` work in the browser:

```javascript
var process = globalThis.process || {};
process.env = process.env || {};
process.env.NODE_ENV = process.env.NODE_ENV || "development";
```

#### Env Injection

The bundler supports injecting environment variables into the preamble via the `env` option on `BundlerConfig`:

```typescript
const config: BundlerConfig = {
  // ...
  env: {
    EXPO_PUBLIC_API_URL: "https://api.example.com",
    NEXT_PUBLIC_SITE_NAME: "My App",
    SECRET_KEY: "abc123", // filtered out -- not public
  },
};
```

For security, only env vars with **public prefixes** are injected into the bundle:

- `EXPO_PUBLIC_*`
- `NEXT_PUBLIC_*`

This prevents accidentally leaking server-side secrets into client-side bundles. `NODE_ENV` is always included (handled separately by the base preamble).

The generated preamble with env vars looks like:

```javascript
var process = globalThis.process || {};
process.env = process.env || {};
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.EXPO_PUBLIC_API_URL = "https://api.example.com";
process.env.NEXT_PUBLIC_SITE_NAME = "My App";
```

User code can then access these values via `process.env.EXPO_PUBLIC_API_URL`, just like in a standard React Native or Next.js app.

The preamble is built by `buildBundlePreamble(env?)` in `utils.ts`, called from both `Bundler.emitBundle()` and `IncrementalBundler.emitBundle()` (including HMR bundles).

### 7. npm Package Bundling

When the bundler encounters `require("lodash")`, it fetches from almostesm:

1. Server receives `GET /pkg/lodash@4.17.21`
2. Creates temp directory, runs `npm install lodash@4.17.21`
3. Reads the installed package's `dependencies` + `peerDependencies` -- all are externalized
4. Bundles with esbuild (IIFE format, browser platform) with a selective external plugin
5. Wraps output with `module.exports = __module`
6. Returns the bundle with an `X-Externals` header containing `{bareName: installedVersion}` for all externalized deps
7. Caches both the `.js` bundle and `.externals.json` manifest to disk

Dependency externalization is critical for two reasons:
- **Shared instances**: packages like `react-dom` must share the same `react` instance as user code
- **Shared transitive deps**: packages like `@react-navigation/core` used by multiple navigation packages are loaded once

The `X-Externals` header enables **version pinning** for transitive dependencies. When the bundler discovers a transitive dep (e.g. `memoize-one` from `react-native-web`), it uses the version from the externals manifest instead of fetching `@latest`. This prevents version mismatches.

### 8. Source Maps

almostmetro generates source maps so that browser dev tools and the UI console show original file names and line numbers, not bundle positions.

#### Per-module source maps

Sucrase generates a `RawSourceMap` for each file it transforms. This maps generated-line/column to original-line/column in the source file. The source map is stored alongside the transformed code.

#### Combined source map

At emit time, all per-module source maps are merged into a single **combined source map** using `buildCombinedSourceMap()`. Each module's mappings are offset by its position in the final bundle (accounting for the preamble, runtime, wrapper function lines, and separators between modules).

The combined source map is appended to the bundle as an inline base64 data URL:

```
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLC...
```

#### Source map utilities (`source-map.ts`)

| Function | Purpose |
|---|---|
| `encodeVLQ` / `decodeVLQ` | Base64 VLQ encoding/decoding for source map segments |
| `decodeMappings` / `encodeMappings` | Convert between mappings string and decoded segment arrays |
| `buildCombinedSourceMap` | Merge per-module maps with line offsets into one map |
| `inlineSourceMap` | Serialize a `RawSourceMap` as an inline base64 data URL comment |
| `shiftSourceMapOrigLines` | Shift all original-line references by an offset (for plugin adjustments) |
| `countNewlines` | Count newline characters in a string |

### 9. Iframe Execution & Rich Error Display

The bundled code does not run directly in the page. Instead, the example app creates two blob URLs and loads them in a sandboxed iframe.

#### JS Blob

The complete bundle string (preamble + runtime + modules + source map) is stored as a `Blob` with type `application/javascript`, and a blob URL is created:

```javascript
const jsBlob = new Blob([bundleCode], { type: "application/javascript" });
const jsBlobUrl = URL.createObjectURL(jsBlob);
// e.g. "blob:http://localhost:5201/abc123-def456"
```

#### HTML Blob

An HTML document is built around the JS blob URL. This HTML is also stored as a blob and used as the iframe's `src`. The HTML contains three script blocks followed by the bundle:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset='UTF-8'>
  <style>html,body,#root{height:100%;margin:0}body{overflow:hidden}</style>
</head>
<body>
  <div id='root'></div>

  <!-- Script 1: Console interception -->
  <script>
    ['log','warn','error','info'].forEach(function(method) {
      var orig = console[method];
      console[method] = function() {
        var text = Array.prototype.slice.call(arguments).map(function(a) {
          if (typeof a === 'object') try { return JSON.stringify(a); } catch(e) { return String(a); }
          return String(a);
        }).join(' ');
        window.parent.postMessage({ type: 'console', method: method, text: text }, '*');
        if (orig) orig.apply(console, arguments);
      };
    });

    // Script 2: Source map resolver + error handlers (ES5-compatible)
    (function() {
      // Mini VLQ decoder (same algorithm as source-map.ts, but in ES5)
      // ...decodeVLQ, decodeMappings functions...

      // Source map store: maps[url] = { sources, decoded }
      // window.__SM API: init(url, mapData), add(url, mapData), resolve(url, line, col)

      // HMR listener: extracts per-module inline source maps from hmr-update messages
      // Stack trace parser (Chrome "at fn (url:line:col)" format)
      // window.onerror + unhandledrejection handlers that:
      //   1. Resolve position via __SM.resolve()
      //   2. Resolve each stack frame
      //   3. Send structured { type: 'runtime-error', message, file, line, column, stack } to parent
    })();
  </script>

  <!-- Script 3 (conditional): Initialize source map for the bundle -->
  <script>
    window.__SM.init("blob:http://localhost:5201/abc123", {
      sources: ["/index.tsx", "/App.tsx", ...],
      mappings: ";;AAAA,..."
    });
  </script>

  <!-- Script 4: The bundle itself (loaded via src, not inline) -->
  <script src="blob:http://localhost:5201/abc123-def456"></script>
</body>
</html>
```

The key insight is that the bundle JS is loaded via `<script src>` (not inlined), so the browser associates the blob URL with the script. When `window.onerror` fires, the `url` parameter is the JS blob URL, which the embedded source map resolver uses to look up the correct source map.

#### Rich error display

When a runtime error occurs, the iframe's error handler resolves it through the source map and sends a structured `runtime-error` message to the parent. The parent renders a rich error view in the console panel:

- **Error message** (bold red)
- **File:line:column location** (orange, pointing to original source)
- **Resolved stack trace** (dimmed, indented frames with original positions)

This works for both full bundle errors and HMR-updated module errors. For HMR updates, the iframe listens for `hmr-update` messages and extracts per-module inline source maps from the updated code strings, registering them with `__SM.add(sourceURL, map)`.

### 10. HMR (Hot Module Replacement)

HMR allows updating individual modules without a full page reload, preserving application state.

#### End-to-end flow

```
 Editor (keystroke)
    │
    ▼
 EditorFS.write()
    │  detects change, debounces
    ▼
 Worker receives "watch-update" message
    │  with ContentChange[] (path, type, content)
    ▼
 IncrementalBundler.rebuild(changes)
    │  1. Invalidate changed module caches
    │  2. Re-transform only changed files
    │  3. Walk any new local deps
    │  4. Fetch any new npm packages
    │  5. Clean up orphaned modules
    │  6. Emit full bundle (for fallback)
    │  7. Build HmrUpdate with per-module code
    ▼
 Worker posts "hmr-update" to parent
    │  { updatedModules: Record<string, string>,
    │    removedModules: string[],
    │    bundle: string (fallback) }
    ▼
 App.tsx broadcasts to all iframe(s) via postMessage
    │
    ▼
 Iframe HMR runtime receives "hmr-update"
    │  1. Find accept boundaries (walk reverse deps)
    │  2. Run dispose callbacks
    │  3. Replace module factories: modules[id] = new Function(code)
    │  4. Delete removed modules
    │  5. Re-execute boundary modules
    │  6. React Refresh: performReactRefresh()
    ▼
 UI updates without page reload
```

#### HMR runtime

The HMR runtime (`hmr-runtime.ts`) is a CommonJS module loader with `module.hot` API support:

- **`module.hot.accept(cb?)`** -- marks the module as an accept boundary. When it or its dependencies change, only modules up to this boundary are re-executed.
- **`module.hot.dispose(cb)`** -- registers a cleanup callback that runs before the module is replaced. Receives a `data` object for passing state to the new version.
- **`module.hot.decline()`** -- forces a full reload when this module changes.

The runtime exposes `window.__BUNDLER_HMR__` and listens for `hmr-update` messages from the parent. On update, it:

1. Walks reverse dependencies from each changed module to find the nearest `accept()` boundary.
2. If no boundary is found, requests a full reload via `postMessage({ type: 'hmr-full-reload' })`.
3. Otherwise: runs dispose callbacks, replaces module factories with `new Function(code)`, clears caches, re-executes boundary modules.

#### React Refresh integration

When `hmr.reactRefresh` is enabled in the config, the bundler uses `reactRefreshTransformer` which wraps each component with `$RefreshReg$` / `$RefreshSig$` calls and appends a `module.hot.accept()` postamble. The HMR runtime initializes the React Refresh runtime before executing the entry module, and calls `performReactRefresh()` after each HMR update to tell React to re-render with updated component definitions.

#### Per-module inline source maps in HMR

Each module in an HMR update includes its own inline source map and `//# sourceURL=` annotation:

```javascript
// updatedModules["/App.tsx"]:
"use strict";
var _App = require("./App");
// ... transformed module code ...
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLC...
//# sourceURL=/App.tsx
```

The source map has 2 extra empty lines prepended (`";;"` in mappings) to account for the `new Function('module','exports','require', code)` wrapper that adds 2 lines before the code starts. The iframe's HMR listener extracts these per-module source maps and registers them with `__SM.add(sourceURL, map)` so runtime errors in HMR-updated modules resolve to correct original positions.

#### Expo Router: HMR for dynamic route addition

Expo Router uses file-based routing where files under `/app/` define routes. When a project uses `"main": "expo-router/entry"`, almostmetro generates a synthetic entry that maps route files to modules. To support HMR when route files are added or removed (without a full reload), the entry is split into two modules:

```
/__expo_ctx.js          /index.tsx (entry)
+---------------------+  +---------------------------+
| var modules = {     |  | const ctx = require(      |
|   "./(tabs)/...":   |  |   "./__expo_ctx"          |
|     require("..."), |  | );                        |
|   ...               |  |                           |
| };                  |  | function App() {          |
| module.exports = ctx|  |   return <ExpoRoot        |
+---------------------+  |     context={ctx} />;     |
  Plain .js file          | }                        |
  (no React Refresh       |                           |
   accept boundary)       | registerRootComponent(App)|
                          +---------------------------+
                            .tsx file → React Refresh
                            adds module.hot.accept()
```

**Why two files?** The route context (`/__expo_ctx.js`) is a plain `.js` file, so the React Refresh transformer does NOT add `module.hot.accept()` to it. This means HMR updates to the context bubble up through the reverse dependency chain until they reach `/index.tsx`, which has the `App` component and IS an accept boundary (React Refresh instrumented). The entry re-executes, `require("./__expo_ctx")` picks up the new route map, React Refresh re-renders App, and the new routes appear.

If the route map were inlined in the entry, the incremental bundler would mark it as `requiresReload: true` (entry file changed), forcing a full reload.

**Route change detection** (`bundler.worker.ts` `handleWatchUpdate`):

When a file under `/app/` with a route extension (`.tsx`, `.ts`, `.jsx`, `.js`) is created or deleted, the worker:
1. Regenerates `/__expo_ctx.js` via `buildExpoRouteContext(watchFS)`
2. Writes it to `watchFS` and appends it to the change list as `type: "update"`
3. The incremental bundler processes it as a normal module change (not an entry change)

**Reverse deps map updates**: Each HMR update includes an updated `reverseDepsMap` from the server-side dependency graph. This is critical for new files because the iframe's runtime has a stale reverse deps map from the initial bundle. Without the update, `findAcceptBoundary()` can't walk from a new module to any accept boundary, causing a full reload.

**Cache clearing order** (Phase 5 in `hmr-runtime.ts`): All module caches in `modulesToReExecute` are cleared in a first pass before any modules are re-executed in a second pass. This prevents an ordering bug where a parent module (e.g., the entry) could re-execute and `require()` a dependency (e.g., `__expo_ctx.js`) before that dependency's cache was cleared, getting stale exports instead of the updated version.

**Double-registration guard**: The synthetic entry guards `registerRootComponent(App)` with `window.__EXPO_ROOT_REGISTERED` to prevent calling `createRoot()` again on HMR re-execution (React Refresh handles the component update via `performReactRefresh()` instead).

#### HMR test buttons (expo-real example)

The editor UI shows two buttons when the `expo-real` project is in watch mode with HMR active:

1. **"Add Settings Tab"** -- writes `/app/(tabs)/settings.tsx` to the virtual filesystem, triggering route context regeneration and HMR
2. **"Update Layout"** -- updates `/app/(tabs)/_layout.tsx` to include the new tab in the tab navigator, triggering a normal component HMR update

These buttons test the full HMR flow for dynamic route addition without requiring manual file editing.

## Directory Structure

```
almostmetro/
  src/                        # Library source (TypeScript)
    types.ts                  # FileMap, ModuleMap, Transformer, BundlerConfig, BundlerPlugin,
                              #   HmrUpdate, IncrementalBuildResult, FileChange, ContentChange
    fs.ts                     # VirtualFS class
    resolver.ts               # Module resolution
    bundler.ts                # One-shot Bundler class
    incremental-bundler.ts    # IncrementalBundler with HMR support
    source-map.ts             # VLQ encode/decode, combined source maps, inline source maps
    hmr-runtime.ts            # HMR-capable bundle runtime template
    dependency-graph.ts       # DependencyGraph for tracking module relationships
    module-cache.ts           # ModuleCache for incremental rebuilds
    utils.ts                  # findRequires, rewriteRequires, buildBundlePreamble, hashString
    transforms/
      typescript.ts           # Default sucrase-based transformer
      react-refresh.ts        # React Refresh transformer (adds $RefreshReg$/$RefreshSig$)
    plugins/
      data-bx-path.ts         # JSX data-bx-path attribute injection plugin
    index.ts                  # Public exports
  dist/                       # Compiled library (tsc output) - example app imports from here
  example/                    # Vite React demo
    user_projects/            # Sample project source files (e.g. expo-real/)
    src/
      App.tsx                 # Editor/preview UI (iframe HTML builder, rich error display)
      bundler.worker.ts       # Web worker orchestrator (creates per-target bundler instances)
      editor-fs.ts            # EditorFS with change tracking for watch mode
      plugins/                # Target-specific plugins
        web-plugin.ts         # Aliases, shims, globals for web target
        expo-web.ts           # React import injection + react-native alias for Expo target
    scripts/                  # Build scripts (projects.json generation)
    public/                   # Static assets (generated projects.json)

almostesm/
  src/index.ts                # Express server
  cache/                      # Bundled npm packages + externals manifests (gitignored)
```

> **Note:** After editing `almostmetro/src/`, run `npm run build` (tsc) in the `almostmetro/` directory. The example app imports from `dist/index.js`, not source directly.

## Design Decisions

**CommonJS over ESM for the bundle runtime** - The bundle runtime uses CommonJS semantics (`require`/`module.exports`). This is simpler to implement as a runtime (synchronous, no TDZ concerns) and matches how npm packages are traditionally bundled. The transformer converts ES imports to CommonJS before bundling.

**Sucrase over Babel/SWC** - Sucrase is chosen as the default transformer because it's fast and works in the browser (pure JS, no WASM). It handles the common case (TypeScript + JSX + import/export) with minimal overhead. The transformer interface allows swapping it for any other tool.

**On-demand package bundling** - Rather than pre-bundling a fixed set of packages, almostesm bundles npm packages the first time they're requested. This means any npm package works without configuration, at the cost of a cold-start delay on first use. Subsequent requests are instant (disk cache).

**IIFE format for npm packages** - Packages are bundled as IIFE (Immediately Invoked Function Expression) with esbuild. The IIFE assigns to a `__module` variable, which our wrapper converts to `module.exports = __module`. The wrapper is kept simple because both Sucrase and esbuild consumers generate their own interop helpers. This approach avoids polluting the global scope and works within our CommonJS factory wrapper.

**Multi-target architecture** - Each target (web, expo) gets its own `Bundler`/`IncrementalBundler` instance with its own config, plugins, cache, and module map. The web worker orchestrator creates per-target instances, runs them in parallel, and merges results. Plugins are target-specific (e.g. web-plugin aliases, expo-plugin React import injection + react-native-web alias).

**Full dependency externalization** - almostesm externalizes ALL `dependencies` + `peerDependencies` (not just peer deps). This ensures shared transitive deps are loaded once at runtime. Version pinning via the `X-Externals` response header prevents version mismatches for transitive dependencies.

**Embedded source map resolver in the iframe** - The browser console resolves source maps automatically, but `window.onerror` receives raw bundle line numbers. Rather than depending on a library like `source-map`, the iframe HTML embeds a lightweight ES5 VLQ decoder (~80 lines) that resolves error positions at runtime. This keeps the iframe self-contained with no external dependencies.

**Blob URL separation (HTML + JS)** - The bundle JS is loaded via `<script src>` from a separate blob URL rather than being inlined in the HTML. This ensures the browser associates error positions with the JS blob URL, which the embedded source map resolver can then look up. It also allows the browser's built-in source map support to work in the dev tools console.
