# browser-metro

A browser-based JavaScript/TypeScript bundler inspired by [Metro](https://metrobundler.dev/) (React Native's bundler). It runs entirely client-side in a Web Worker with HMR, React Refresh, Expo Router, and source map support.

Part of [reactnative.run](https://reactnative.run) - try the [playground](https://reactnative.run/playground).

## Features

- **VirtualFS** - in-memory filesystem, no real FS needed
- **Module resolution** - Node.js-style with configurable extensions
- **Sucrase transforms** - fast TypeScript/JSX compilation
- **Plugin system** - pre/post transform hooks, module aliases, shims
- **HMR** - hot module replacement with React Refresh
- **Expo Router** - file-based routing with dynamic route HMR
- **API Routes** - in-browser `+api.ts` via fetch interception
- **Source maps** - inline combined source maps for accurate errors
- **npm packages** - on-demand bundling via ESM server

## Install

```bash
npm install browser-metro
```

## Quick Start

```typescript
import {
  Bundler, VirtualFS, typescriptTransformer
} from "browser-metro";
import type { BundlerConfig, FileMap } from "browser-metro";

const files: FileMap = {
  "/index.ts": 'import { greet } from "./utils";\nconsole.log(greet("World"));',
  "/utils.ts": 'export function greet(name: string) { return "Hello, " + name; }',
};

const bundler = new Bundler(new VirtualFS(files), {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: "https://esm.reactnative.run" },
});

const code = await bundler.bundle("/index.ts");
// code is a self-executing bundle with inline source map
```

## HMR with React Refresh

```typescript
import {
  IncrementalBundler, VirtualFS, reactRefreshTransformer
} from "browser-metro";

const bundler = new IncrementalBundler(new VirtualFS(files), {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: reactRefreshTransformer,
  server: { packageServerUrl: "https://esm.reactnative.run" },
  hmr: { enabled: true, reactRefresh: true },
});

// Initial build
const initial = await bundler.build("/index.tsx");

// On file change - only re-transforms changed files
const result = await bundler.rebuild([
  { path: "/App.tsx", type: "update" }
]);

if (result.hmrUpdate && !result.hmrUpdate.requiresReload) {
  // Send to iframe for hot patching
  iframe.postMessage({
    type: "hmr-update",
    updatedModules: result.hmrUpdate.updatedModules,
    removedModules: result.hmrUpdate.removedModules,
  });
}
```

## API

### Bundler

One-shot bundler. Creates a single bundle from an entry file.

```typescript
const bundler = new Bundler(vfs, config);
const code = await bundler.bundle("/index.ts");
```

### IncrementalBundler

Watch-mode bundler with HMR. Maintains dependency graph and module cache across rebuilds.

```typescript
const bundler = new IncrementalBundler(vfs, config);
const initial = await bundler.build("/index.tsx");
const update = await bundler.rebuild([{ path: "/App.tsx", type: "update" }]);
```

### VirtualFS

In-memory filesystem.

```typescript
const vfs = new VirtualFS(files);
vfs.read("/index.ts");      // string | undefined
vfs.write("/new.ts", code);  // create or overwrite
vfs.exists("/index.ts");     // boolean
vfs.list();                  // string[]
```

### BundlerConfig

```typescript
interface BundlerConfig {
  resolver: { sourceExts: string[] };
  transformer: Transformer;
  server: { packageServerUrl: string };
  hmr?: { enabled: boolean; reactRefresh?: boolean };
  plugins?: BundlerPlugin[];
  env?: Record<string, string>;
}
```

### Transformers

- `typescriptTransformer` - TS/JSX via Sucrase
- `reactRefreshTransformer` - adds React Refresh + `module.hot.accept()`
- `createReactRefreshTransformer(base)` - wrap a custom transformer with React Refresh

### Plugins

```typescript
interface BundlerPlugin {
  name: string;
  transformSource?(params): { src: string } | null;   // before Sucrase
  transformOutput?(params): { code: string } | null;   // after Sucrase
  resolveRequest?(context, name): string | null;       // custom resolution
  moduleAliases?(): Record<string, string>;            // redirect requires
  shimModules?(): Record<string, string>;              // inline replacements
}
```

## ESM Package Server

browser-metro fetches npm packages from an ESM server that bundles them on-demand with esbuild:

```
https://esm.reactnative.run/pkg/lodash@4.17.21
https://esm.reactnative.run/pkg/react-dom@19/client
```

Packages are cached after first request. All dependencies are externalized for shared runtime instances. Version pinning via `// @externals` metadata prevents transitive dependency mismatches.

## Documentation

Full docs at [reactnative.run/docs](https://reactnative.run/docs):

- [Architecture](https://reactnative.run/docs/architecture)
- [HMR & React Refresh](https://reactnative.run/docs/hmr)
- [Expo Router](https://reactnative.run/docs/expo-router)
- [API Routes](https://reactnative.run/docs/api-routes)
- [Plugin System](https://reactnative.run/docs/api/plugins)
- [Full API Reference](https://reactnative.run/docs/api/bundler)

## Author

Built by [Sanket Sahu](https://github.com/sanketsahu) at [RapidNative](https://rapidnative.com).

## License

MIT
