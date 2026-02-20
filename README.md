# almostmetro

A browser-based JavaScript/TypeScript bundler inspired by Metro. It provides a virtual filesystem, a CommonJS module bundler with a pluggable transformer pipeline, and **almostesm** -- an npm package server that bundles packages on-demand.

## Architecture

The project has three components:

| Component | Path | Description |
|---|---|---|
| **almostmetro** (library) | `almostmetro/` | Virtual FS, resolver, bundler, transformer pipeline |
| **almostesm** | `almostesm/` | Express server that installs and bundles npm packages on-demand |
| **example** | `almostmetro/example/` | Vite + React app demonstrating the library |

```
almostmetro/               # Library (published as "almostmetro")
  src/
    types.ts               # Core interfaces
    fs.ts                  # VirtualFS class
    resolver.ts            # Module resolution with configurable extensions
    bundler.ts             # Bundler class - graph walking, transforms, emit
    transforms/
      typescript.ts        # Default TS/JSX transformer (sucrase)
    plugins/
      data-bx-path.ts      # JSX data-bx-path attribute injection plugin
    index.ts               # Public exports
  dist/                    # Compiled output (tsc)
  example/                 # Vite React demo app
    user_projects/         # Sample projects (basic, typescript, react)
    src/
      App.tsx              # Editor UI using almostmetro
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
- **almostesm** at `http://localhost:3001`
- **Library** in watch mode (recompiles on changes)
- **Vite dev server** at `http://localhost:5173`

## Library API

```typescript
import { Bundler, VirtualFS, typescriptTransformer } from "almostmetro";
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
  server: { packageServerUrl: "http://localhost:3001" },
};

// 3. Bundle
const bundler = new Bundler(vfs, config);
const code = await bundler.bundle("/index.ts");

// 4. Execute (e.g. in an iframe, eval, etc.)
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

- `http://localhost:5173/` - basic JS project with lodash
- `http://localhost:5173/?project=typescript` - TypeScript project
- `http://localhost:5173/?project=react` - React app with components and hooks

## Documentation

- [Architecture](docs/architecture.md) - System design and data flow
- [Library API](docs/api.md) - VirtualFS, Bundler, Resolver, types
- [Transformer System](docs/transformers.md) - How transforms work, writing custom transformers
- [almostesm](docs/almostesm.md) - npm package bundling service
- [Example App](docs/example.md) - The Vite React demo application
