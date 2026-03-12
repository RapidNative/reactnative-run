# almostmetro

A browser-based JavaScript/TypeScript bundler inspired by Metro. It provides a virtual filesystem, a CommonJS module bundler with a pluggable transformer and plugin pipeline, source maps, HMR with React Refresh, and **almostesm** -- an npm package server that bundles packages on-demand.

## Architecture

The project has three components:

| Component | Path | Description |
|---|---|---|
| **almostmetro** (library) | `almostmetro/` | Virtual FS, resolver, bundler, transformer/plugin pipeline, source maps, HMR |
| **almostesm** | `almostesm/` | Express server that installs and bundles npm packages on-demand |
| **example** | `almostmetro/example/` | Vite + React app demonstrating the library |

```
almostmetro/               # Library (published as "almostmetro")
  src/
    types.ts               # Core interfaces (BundlerConfig, BundlerPlugin, HmrUpdate, etc.)
    fs.ts                  # VirtualFS class
    resolver.ts            # Module resolution with configurable extensions
    bundler.ts             # One-shot Bundler class
    incremental-bundler.ts # IncrementalBundler with HMR support
    source-map.ts          # VLQ encode/decode, combined source maps
    hmr-runtime.ts         # HMR bundle runtime template
    transforms/
      typescript.ts        # Default TS/JSX transformer (sucrase)
      react-refresh.ts     # React Refresh transformer for HMR
    plugins/
      data-bx-path.ts      # JSX data-bx-path attribute injection plugin
    index.ts               # Public exports
  dist/                    # Compiled output (tsc)
  example/                 # Vite React demo app
    user_projects/         # Sample projects (basic, typescript, react, expo-real)
    src/
      App.tsx              # Editor UI, preview iframes, console, HTML blob builder
      bundler.worker.ts    # Web worker orchestrator
      editor-fs.ts         # EditorFS with change tracking for watch mode
    scripts/
      build-projects.ts
almostesm/                 # npm package bundling service
  src/index.ts
  cache/                   # Cached bundled packages
```

## Quick Start

```bash
# Install dependencies
npm install
npm install --prefix almostmetro
npm install --prefix almostmetro/example
npm install --prefix almostesm

# Build the library
npm run build --prefix almostmetro

# Start all three services (library watch + almostesm + vite dev)
npm run dev
```

This starts:
- **almostesm** at `http://localhost:5200`
- **Library** in watch mode (recompiles on changes)
- **Vite dev server** at `http://localhost:5201`

## Library API

```typescript
import {
  Bundler, IncrementalBundler, VirtualFS,
  typescriptTransformer, reactRefreshTransformer,
  createDataBxPathPlugin,
} from "almostmetro";
import type { BundlerConfig, FileMap } from "almostmetro";

// 1. Create a virtual filesystem from a file map
const files: FileMap = {
  "/index.ts": 'import { greet } from "./utils";\nconsole.log(greet("World"));',
  "/utils.ts": 'export function greet(name: string) { return "Hello, " + name; }',
};
const vfs = new VirtualFS(files);

// 2. Configure the bundler
const config: BundlerConfig = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: "http://localhost:5200" },
  plugins: [createDataBxPathPlugin()],  // optional plugins
};

// 3. Bundle (one-shot)
const bundler = new Bundler(vfs, config);
const code = await bundler.bundle("/index.ts");
// code includes inline source map

// 4. Execute (e.g. in an iframe, eval, etc.)

// -- Or use IncrementalBundler for watch mode with HMR --
const watchConfig: BundlerConfig = {
  ...config,
  transformer: reactRefreshTransformer,
  hmr: { enabled: true, reactRefresh: true },
};
const incBundler = new IncrementalBundler(vfs, watchConfig);
const initial = await incBundler.build("/index.ts");
// On file change:
const result = await incBundler.rebuild([{ path: "/utils.ts", type: "update" }]);
// result.hmrUpdate contains per-module code for hot patching
```

## almostesm (unpkg-style URLs)

almostesm bundles npm packages on-demand for browser consumption:

```
GET /pkg/lodash              -> lodash@latest
GET /pkg/lodash@4.17.21      -> lodash@4.17.21
GET /pkg/react-dom/client    -> react-dom@latest, subpath /client
GET /pkg/react-dom@19/client -> react-dom@19, subpath /client
GET /pkg/@scope/name@1.0/sub -> scoped package with subpath
```

Peer dependencies are automatically externalized to prevent duplicate instances (e.g. `react-dom` won't bundle its own copy of `react`).

## Sample Projects

Switch between projects in the example app using the dropdown or URL params:

- `http://localhost:5201/` - basic JS project with lodash
- `http://localhost:5201/?project=typescript` - TypeScript project
- `http://localhost:5201/?project=react` - React app with components and hooks

## Documentation

- [Architecture](docs/architecture.md) - System design and data flow
- [Library API](docs/api.md) - VirtualFS, Bundler, Resolver, types
- [Transformer System](docs/transformers.md) - How transforms work, writing custom transformers
- [almostesm](docs/almostesm.md) - npm package bundling service
- [Example App](docs/example.md) - The Vite React demo application
