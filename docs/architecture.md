# Architecture

## Overview

almostmetro is a browser-based bundler that mirrors the architecture of Metro (React Native's bundler) in a simplified form. The system has three runtime components that work together:

```
Browser (example app)          Package Server (:3001)
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

### 4. Transformation

Before bundling, each file passes through the configured `Transformer`. The transformer receives the source code and filename, and returns transformed code. The default `typescriptTransformer` uses sucrase:

- `.ts` files: strip TypeScript types, convert ES imports to CommonJS
- `.tsx` files: strip TypeScript types, convert JSX, convert imports
- `.jsx` files: convert JSX, convert imports
- `.js` files: convert ES imports to CommonJS

The transform converts everything to CommonJS (`require`/`module.exports`) because the bundle runtime uses a CommonJS module system.

### 5. Bundle Generation

The bundler walks the dependency graph starting from the entry file:

1. **Walk** - recursively follow `require()` calls, transforming each file
2. **Collect npm packages** - track any require targets that are npm packages
3. **Fetch packages** - download pre-bundled npm packages from the package server in parallel
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

### 6. npm Package Bundling

When the bundler encounters `require("lodash")`, it fetches from the package server:

1. Server receives `GET /pkg/lodash`
2. Creates temp directory, runs `npm install lodash`
3. Reads the installed package's `peerDependencies`
4. Bundles with esbuild (IIFE format, browser platform), marking peers as external
5. Wraps output to expose `module.exports`
6. Caches to disk for subsequent requests

Peer dependency externalization is critical for packages like `react-dom` which must share the same `react` instance as user code. The externalized `require("react")` call gets resolved by our bundle runtime to the same cached module.

### 7. Execution

The bundled code runs in a sandboxed iframe:
- Console methods are intercepted and forwarded to the parent via `postMessage`
- Uncaught errors are captured and reported
- Each run creates a fresh iframe to avoid state leaking between runs

## Directory Structure

```
almostmetro/
  src/                    # Library source (TypeScript)
    types.ts              # FileMap, ModuleMap, Transformer, BundlerConfig
    fs.ts                 # VirtualFS class
    resolver.ts           # Module resolution
    bundler.ts            # Bundler class (graph walk + transform + emit)
    transforms/
      typescript.ts       # Default sucrase-based transformer
    index.ts              # Public exports
  dist/                   # Compiled library (tsc output)
  example/                # Vite React demo
    user_projects/        # Sample project source files
    src/                  # React app source
    scripts/              # Build scripts (projects.json generation)
    public/               # Static assets (generated projects.json)

package-server/
  src/index.ts            # Express server
  cache/                  # Bundled npm packages (gitignored)
```

## Design Decisions

**CommonJS over ESM for the bundle runtime** - The bundle runtime uses CommonJS semantics (`require`/`module.exports`). This is simpler to implement as a runtime (synchronous, no TDZ concerns) and matches how npm packages are traditionally bundled. The transformer converts ES imports to CommonJS before bundling.

**Sucrase over Babel/SWC** - Sucrase is chosen as the default transformer because it's fast and works in the browser (pure JS, no WASM). It handles the common case (TypeScript + JSX + import/export) with minimal overhead. The transformer interface allows swapping it for any other tool.

**On-demand package bundling** - Rather than pre-bundling a fixed set of packages, the package server bundles npm packages the first time they're requested. This means any npm package works without configuration, at the cost of a cold-start delay on first use. Subsequent requests are instant (disk cache).

**IIFE format for npm packages** - Packages are bundled as IIFE (Immediately Invoked Function Expression) with esbuild. The IIFE assigns to a `__module` variable, which our wrapper converts to `module.exports`. This approach avoids polluting the global scope and works within our CommonJS factory wrapper.
