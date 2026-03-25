<p align="center">
  <img src="browser-metro/example/public/logo.svg" width="64" height="64" alt="reactnative.run logo" />
</p>

<h1 align="center">reactnative.run</h1>

<p align="center">
  Run React Native in your browser. Write, bundle, and preview with HMR, Expo Router, and npm support &mdash; all client-side.
</p>

<p align="center">
  <a href="https://reactnative.run">Website</a> &middot;
  <a href="https://reactnative.run/playground">Playground</a> &middot;
  <a href="https://reactnative.run/docs">Documentation</a>
</p>

---

## What is this?

**reactnative.run** is an open-source, browser-based development environment for React Native apps. It consists of three components:

| Component | Path | Description |
|---|---|---|
| **browser-metro** | `browser-metro/` | Client-side JavaScript bundler that mirrors Metro's architecture |
| **reactnative-esm** | `reactnative-esm/` | Express server that bundles npm packages on-demand with esbuild |
| **website** | `website/` | Next.js app for [reactnative.run](https://reactnative.run) (landing page, docs, playground) |

## Features

- **Zero setup** &mdash; open the browser and start coding React Native
- **Hot Module Replacement** &mdash; edit code, see changes instantly with React Refresh
- **Expo Router** &mdash; file-based routing with dynamic route addition via HMR
- **API Routes** &mdash; `+api.ts` files run in-browser via fetch interception
- **Any npm package** &mdash; packages bundled on-demand, cached for instant reuse
- **Source maps** &mdash; errors show original file names and line numbers
- **Monaco Editor** &mdash; TypeScript support, syntax highlighting, autocomplete
- **Dark/light theme** &mdash; toggle in the playground header
- **Resizable panels** &mdash; file explorer, editor, preview, console

## Quick Start

```bash
# Install dependencies
npm install

# Start everything (ESM server + library watch + playground + website)
npm run dev

# Or start individual services
npm run dev:bundler    # ESM server + browser-metro + playground
npm run dev:website    # Next.js website only
```

This starts:
- **reactnative-esm** at `http://localhost:5200`
- **browser-metro** library in watch mode
- **Playground** at `http://localhost:5201`
- **Website** at `http://localhost:3000`

## Build

```bash
# Build everything (browser-metro + playground + website)
npm run build

# Build playground and copy to website
npm run build:playground

# Build website only
npm run build:website

# Build browser-metro library only
npm run build:metro
```

## Project Structure

```
browser-metro/                # Core bundler library (npm: browser-metro)
  src/
    types.ts                  # Core interfaces
    fs.ts                     # VirtualFS class
    resolver.ts               # Module resolution
    bundler.ts                # One-shot Bundler
    incremental-bundler.ts    # IncrementalBundler with HMR
    source-map.ts             # Source map utilities
    hmr-runtime.ts            # HMR runtime template
    transforms/               # Sucrase + React Refresh transformers
    plugins/                  # data-bx-path plugin
  example/                    # Vite playground app
    src/
      App.tsx                 # Editor, preview, console UI
      FileExplorer.tsx        # Tree-view file explorer
      bundler.worker.ts       # Web worker orchestrator
      editor-fs.ts            # EditorFS with change tracking
      monaco-ts-setup.ts      # TypeScript support for Monaco
      plugins/
        expo-web.ts           # React Native Web shims + aliases
    user_projects/            # Sample projects (expo, basic, react, etc.)

reactnative-esm/             # npm package bundling service
  src/index.ts                # Express server

website/                      # Next.js app (reactnative.run)
  src/app/
    page.tsx                  # Landing page
    docs/                     # MDX documentation (20+ pages)
    playground/               # Playground iframe wrapper
    og-image/                 # OG image template
  src/components/             # Shared components (nav, features, etc.)

scripts/
  build-playground.sh         # Build playground + copy to website/public
```

## Library Usage

```typescript
import {
  Bundler, VirtualFS, typescriptTransformer
} from "browser-metro";

const files = {
  "/index.ts": 'console.log("Hello from browser-metro!");',
};

const bundler = new Bundler(new VirtualFS(files), {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: "https://esm.reactnative.run" },
});

const code = await bundler.bundle("/index.ts");
```

For HMR with React Refresh:

```typescript
import {
  IncrementalBundler, VirtualFS, reactRefreshTransformer
} from "browser-metro";

const bundler = new IncrementalBundler(vfs, {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: reactRefreshTransformer,
  server: { packageServerUrl: "https://esm.reactnative.run" },
  hmr: { enabled: true, reactRefresh: true },
});

const initial = await bundler.build("/index.tsx");

// On file change:
const result = await bundler.rebuild([{ path: "/App.tsx", type: "update" }]);
// result.hmrUpdate contains per-module code for hot patching
```

## ESM Package Server

reactnative-esm bundles npm packages on-demand for browser consumption:

```
GET /pkg/lodash              -> lodash@latest
GET /pkg/lodash@4.17.21      -> lodash@4.17.21
GET /pkg/react-dom/client    -> react-dom@latest, subpath /client
GET /pkg/@scope/name@1.0/sub -> scoped package with subpath
```

In production: `https://esm.reactnative.run`

All dependencies are externalized and version-pinned via `X-Externals` headers to prevent mismatches.

## Documentation

Full documentation is available at [reactnative.run/docs](https://reactnative.run/docs):

- [Introduction](https://reactnative.run/docs) &mdash; overview of all components
- [Quick Start](https://reactnative.run/docs/quick-start) &mdash; get up and running
- [Architecture](https://reactnative.run/docs/architecture) &mdash; system design and data flow
- [HMR & React Refresh](https://reactnative.run/docs/hmr) &mdash; hot module replacement
- [Expo Router](https://reactnative.run/docs/expo-router) &mdash; file-based routing
- [API Routes](https://reactnative.run/docs/api-routes) &mdash; in-browser fetch interception
- [Shims & Polyfills](https://reactnative.run/docs/shims) &mdash; what's shimmed for web
- [Comparison](https://reactnative.run/docs/comparison) &mdash; vs Expo Snack, CodeSandbox, StackBlitz
- [API Reference](https://reactnative.run/docs/api/bundler) &mdash; Bundler, IncrementalBundler, VirtualFS, Plugins, Types
- [ESM Server](https://reactnative.run/docs/esm-server) &mdash; package bundling service

## Origin Story

The previous version used ES Modules to run React Native code directly in the browser. The current version takes a different approach: a CommonJS bundler that mirrors Metro's architecture but runs entirely client-side in a Web Worker.

Read more: [How to build a dev server in the browser](https://expo.dev/blog/how-to-build-a-dev-server-in-the-browser) (Expo blog)

## Author

Built by [Sanket Sahu](https://github.com/sanketsahu) ([@sanketsahu](https://x.com/sanketsahu)) at [RapidNative](https://rapidnative.com).

## License

MIT

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Meta, Facebook, or the React Native team. React Native is a trademark of Meta Platforms, Inc. The domain name "reactnative.run" is simply a descriptive name for this open-source tool.
