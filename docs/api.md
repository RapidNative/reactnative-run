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

The main bundler class. Takes a `VirtualFS` and `BundlerConfig`, walks the dependency graph, transforms files, fetches npm packages, and emits an executable bundle.

```typescript
import { Bundler, VirtualFS, typescriptTransformer } from "almostmetro";
import type { BundlerConfig } from "almostmetro";

const config: BundlerConfig = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: "http://localhost:3001" },
};

const bundler = new Bundler(vfs, config);
```

### Methods

#### `async bundle(entryFile: string): Promise<string>`
Bundles the project starting from `entryFile`. Returns the complete bundle as a string that can be executed (e.g. via `eval()`, `<script>` tag, or iframe).

```typescript
const code = await bundler.bundle("/index.ts");
// code is a self-executing bundle string
```

The bundle process:
1. Walks the dependency graph from the entry file
2. Transforms each file using `config.transformer`
3. Rewrites relative `require()` calls to absolute paths
4. Fetches any npm packages from almostesm
5. Emits a self-executing CommonJS bundle

#### `transformFile(filename: string, src: string): string`
Transforms a single file using the configured transformer. Useful for one-off transforms outside of bundling (e.g. for syntax highlighting, or react-refresh injection).

```typescript
const jsCode = bundler.transformFile("/app.tsx", tsxSource);
```

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
  code: string;      // transformed source code
}
```

### `BundlerConfig`
```typescript
interface BundlerConfig {
  resolver: ResolverConfig;
  transformer: Transformer;
  server: { packageServerUrl: string };
}
```

### `ResolverConfig`
```typescript
interface ResolverConfig {
  sourceExts: string[];  // e.g. ["ts", "tsx", "js", "jsx"]
}
```

---

## typescriptTransformer

A pre-configured `Transformer` using sucrase. Handles TypeScript, JSX, and ES module syntax.

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
