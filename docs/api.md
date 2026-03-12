# Library API

almostmetro exports the following classes, functions, and types.

## VirtualFS

An in-memory filesystem wrapping a `FileMap`.

```typescript
import { VirtualFS } from "almostmetro";
import type { FileMap } from "almostmetro";

const files: FileMap = {
  "/index.js": 'console.log("hello");',
  "/utils.js": 'module.exports = { add: (a, b) => a + b };',
};

const vfs = new VirtualFS(files);
```

### Methods

#### `read(path: string): string | undefined`
Returns the file contents, or `undefined` if the file doesn't exist.

```typescript
const src = vfs.read("/index.js"); // 'console.log("hello");'
const missing = vfs.read("/nope"); // undefined
```

#### `write(path: string, content: string): void`
Creates or overwrites a file.

```typescript
vfs.write("/newfile.js", "module.exports = 42;");
```

#### `exists(path: string): boolean`
Checks if a file exists.

```typescript
vfs.exists("/index.js"); // true
vfs.exists("/nope");     // false
```

#### `list(): string[]`
Returns all file paths.

```typescript
vfs.list(); // ["/index.js", "/utils.js"]
```

#### `getEntryFile(): string | null`
Returns the first matching entry file from the list: `/index.js`, `/index.ts`, `/index.tsx`, `/index.jsx`. Returns `null` if none found.

```typescript
vfs.getEntryFile(); // "/index.js"
```

#### `toFileMap(): FileMap`
Returns a copy of the internal file map.

---

## Bundler

The main one-shot bundler class. Takes a `VirtualFS` and `BundlerConfig`, walks the dependency graph, transforms files, fetches npm packages, and emits an executable bundle with an appended inline source map.

```typescript
import { Bundler, VirtualFS, typescriptTransformer } from "almostmetro";
import type { BundlerConfig } from "almostmetro";

const config: BundlerConfig = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: "http://localhost:5200" },
};

const bundler = new Bundler(vfs, config);
```

### Methods

#### `async bundle(entryFile: string): Promise<string>`
Bundles the project starting from `entryFile`. Returns the complete bundle as a string that can be executed (e.g. via `eval()`, `<script>` tag, or iframe).

```typescript
const code = await bundler.bundle("/index.ts");
// code is a self-executing bundle string with inline source map
```

The bundle process:
1. Walks the dependency graph from the entry file
2. Runs the plugin + transformer pipeline on each file
3. Rewrites relative `require()` calls to absolute paths
4. Fetches any npm packages from almostesm
5. Emits a self-executing CommonJS bundle with combined source map

#### `transformFile(filename: string, src: string): string`
Transforms a single file using the configured transformer (including plugin hooks). Useful for one-off transforms outside of bundling.

```typescript
const jsCode = bundler.transformFile("/app.tsx", tsxSource);
```

---

## IncrementalBundler

A watch-mode bundler that maintains an internal dependency graph, module cache, and module map across rebuilds. Only re-transforms changed files and their affected dependents.

```typescript
import { IncrementalBundler, VirtualFS, reactRefreshTransformer } from "almostmetro";
import type { BundlerConfig } from "almostmetro";

const config: BundlerConfig = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: reactRefreshTransformer,
  server: { packageServerUrl: "http://localhost:5200" },
  hmr: { enabled: true, reactRefresh: true },
  plugins: [myPlugin],
};

const bundler = new IncrementalBundler(vfs, config);
```

### Methods

#### `async build(entryFile: string): Promise<IncrementalBuildResult>`
Performs the initial full build. Must be called before `rebuild()`.

```typescript
const result = await bundler.build("/index.tsx");
// result.bundle -- full bundle string
// result.type -- "full"
// result.hmrUpdate -- null (initial build)
```

#### `async rebuild(changes: FileChange[]): Promise<IncrementalBuildResult>`
Incrementally rebuilds based on file changes. Returns a result that may include an HMR update.

```typescript
const result = await bundler.rebuild([
  { path: "/App.tsx", type: "update" },
]);

if (result.hmrUpdate && !result.hmrUpdate.requiresReload) {
  // Send HMR update to iframe
  iframe.postMessage({
    type: "hmr-update",
    updatedModules: result.hmrUpdate.updatedModules,
    removedModules: result.hmrUpdate.removedModules,
  });
} else {
  // Full reload needed
  loadBundle(result.bundle);
}
```

#### `updateFS(fs: VirtualFS): void`
Replaces the internal VirtualFS (call after modifying files, before `rebuild()`).

---

## Resolver

Module resolution engine. Used internally by the Bundler, but also exported for direct use.

```typescript
import { Resolver, VirtualFS } from "almostmetro";

const resolver = new Resolver(vfs, { sourceExts: ["ts", "tsx", "js", "jsx"] });
```

### Methods

#### `isNpmPackage(target: string): boolean`
Returns `true` if the target is an npm package (doesn't start with `.` or `/`).

```typescript
resolver.isNpmPackage("lodash");     // true
resolver.isNpmPackage("./utils");    // false
resolver.isNpmPackage("/abs/path");  // false
```

#### `resolvePath(from: string, to: string): string`
Resolves a relative import path against the importing file's directory.

```typescript
resolver.resolvePath("/src/components/App.tsx", "../utils");
// "/src/utils"
```

#### `resolveFile(resolved: string): string | null`
Finds the actual file for a resolved path, trying configured extensions and index files. Returns `null` if not found.

```typescript
// Given files: { "/utils.ts": "..." }
resolver.resolveFile("/utils");   // "/utils.ts"
resolver.resolveFile("/missing"); // null
```

Resolution order:
1. Exact match (e.g. `/utils`)
2. With each source extension (e.g. `/utils.ts`, `/utils.tsx`, `/utils.js`, `/utils.jsx`)
3. Index files (e.g. `/utils/index.ts`, `/utils/index.tsx`, etc.)

---

## Types

### `FileMap`
```typescript
interface FileMap {
  [path: string]: string;  // absolute path -> source code
}
```

### `ModuleMap`
```typescript
interface ModuleMap {
  [id: string]: string;  // module ID -> transformed source
}
```

### `Transformer`
```typescript
interface Transformer {
  transform(params: TransformParams): TransformResult;
}

interface TransformParams {
  src: string;       // source code
  filename: string;  // e.g. "/app.tsx"
}

interface TransformResult {
  code: string;           // transformed source code
  sourceMap?: RawSourceMap; // optional source map (used for error mapping)
}
```

### `BundlerConfig`
```typescript
interface BundlerConfig {
  resolver: ResolverConfig;
  transformer: Transformer;
  server: { packageServerUrl: string };
  hmr?: { enabled: boolean; reactRefresh?: boolean };
  plugins?: BundlerPlugin[];
  env?: Record<string, string>;       // environment variables to inject
  routerShim?: boolean;               // enable router shim for Expo Router
}
```

### `ResolverConfig`
```typescript
interface ResolverConfig {
  sourceExts: string[];  // e.g. ["ts", "tsx", "js", "jsx"]
  paths?: Record<string, string[]>;  // tsconfig "paths", e.g. { "@/*": ["./*"] }
}
```

### `BundlerPlugin`
```typescript
interface BundlerPlugin {
  name: string;

  /** Runs BEFORE Sucrase. Receives raw .tsx/.ts source (JSX still intact). */
  transformSource?(params: { src: string; filename: string }): { src: string } | null;

  /** Runs AFTER Sucrase. Receives CommonJS output. */
  transformOutput?(params: { code: string; filename: string }): { code: string } | null;

  /** Custom module resolution. Return a resolved path or npm name, or null to fall through. */
  resolveRequest?(context: { fromFile: string }, moduleName: string): string | null;

  /** Module aliases: { source: target }. require(source) re-exports target. */
  moduleAliases?(): Record<string, string>;

  /** Module shims: { moduleName: inlineCode }. Replaces npm packages with inline code. */
  shimModules?(): Record<string, string>;
}
```

### `HmrUpdate`
```typescript
interface HmrUpdate {
  updatedModules: Record<string, string>;  // module ID -> new code (with inline source map)
  removedModules: string[];
  requiresReload: boolean;
  reloadReason?: string;
}
```

### `IncrementalBuildResult`
```typescript
interface IncrementalBuildResult {
  bundle: string;                  // full bundle string (always available)
  hmrUpdate: HmrUpdate | null;    // null for initial build
  type: "full" | "incremental";
  rebuiltModules: string[];
  removedModules: string[];
  buildTime: number;               // milliseconds
}
```

### `FileChange`
```typescript
interface FileChange {
  path: string;
  type: "create" | "update" | "delete";
}
```

### `ContentChange`
```typescript
interface ContentChange {
  path: string;
  type: "create" | "update" | "delete";
  content?: string;  // omitted for delete
}
```

---

## Transformers

### typescriptTransformer

A pre-configured `Transformer` using sucrase. Handles TypeScript, JSX, and ES module syntax. Returns source maps.

```typescript
import { typescriptTransformer } from "almostmetro";
```

Transform behavior by file extension:

| Extension | Transforms applied |
|---|---|
| `.ts` | `typescript`, `imports` |
| `.tsx` | `typescript`, `jsx`, `imports` |
| `.jsx` | `jsx`, `imports` |
| `.js` | `imports` |

The `imports` transform converts ES module syntax (`import`/`export`) to CommonJS (`require`/`module.exports`).

### reactRefreshTransformer

Extends `typescriptTransformer` with React Refresh support. Wraps each component with `$RefreshReg$` / `$RefreshSig$` calls and appends a `module.hot.accept()` postamble. Used in watch mode.

```typescript
import { reactRefreshTransformer } from "almostmetro";
```

---

## Plugins

### createDataBxPathPlugin

Creates a plugin that injects `data-bx-path` attributes into JSX elements, enabling click-to-source functionality.

```typescript
import { createDataBxPathPlugin } from "almostmetro";

const plugin = createDataBxPathPlugin();
// Use in config: plugins: [plugin]
```

The plugin runs as a `transformSource` hook (before Sucrase, while JSX is still intact). It uses a character scanner to walk the source and:

- **Lowercase HTML tags** (`<div>`, `<span>`) get `data-bx-path="filename:line:col"` -- React passes `data-*` attributes through to the DOM.
- **Uppercase component tags** (`<View>`, `<Text>`) get `dataSet={{"bx-path":"filename:line:col"}}` -- React Native Web's `dataSet` prop renders as `data-*` attributes on the host DOM element.

Fragments (`<Fragment>`, `<React.Fragment>`) and generics (`<Comp<T>>`) are skipped.
