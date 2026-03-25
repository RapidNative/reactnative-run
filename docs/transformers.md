# Transformer System

browser-metro uses a pluggable transformer pipeline inspired by Metro's transformer architecture. Every file passes through a `Transformer` before being added to the bundle.

## How It Works

During bundling, each file passes through a three-stage pipeline. The `Transformer` is the core stage, but plugins can hook in before and after:

```
   BundlerPlugin.transformSource()   ← pre-transform hooks (raw JSX/TS)
              │
   Transformer.transform()          ← core transform (e.g. Sucrase)
              │
   BundlerPlugin.transformOutput()   ← post-transform hooks (CJS output)
```

The core transform call looks like:

```typescript
const transformed = this.config.transformer.transform({
  src: fileContents,
  filename: "/path/to/file.tsx"
});
// transformed.code is CJS-compatible JavaScript
// transformed.sourceMap is an optional RawSourceMap
```

The transformer is responsible for converting the source into plain JavaScript with CommonJS module syntax (`require`/`module.exports`). This is the format the bundle runtime expects.

## The Transformer Interface

```typescript
interface TransformParams {
  src: string;       // Raw source code
  filename: string;  // File path (e.g. "/App.tsx") - use for extension detection
}

interface TransformResult {
  code: string;              // Transformed JavaScript
  sourceMap?: RawSourceMap;  // Optional source map for error mapping
}

interface Transformer {
  transform(params: TransformParams): TransformResult;
}
```

## Built-in: typescriptTransformer

The default transformer uses [sucrase](https://github.com/alangpierce/sucrase) for fast TypeScript and JSX compilation.

```typescript
import { typescriptTransformer } from "browser-metro";

const config = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: "http://localhost:5200" },
};
```

It detects the file extension and applies the appropriate sucrase transforms:

```typescript
// .ts  -> ["typescript", "imports"]
// .tsx -> ["typescript", "jsx", "imports"]
// .jsx -> ["jsx", "imports"]
// .js  -> ["imports"]
```

## Writing a Custom Transformer

### Passthrough (no-op)

The simplest transformer that does nothing:

```typescript
const noopTransformer: Transformer = {
  transform({ src }) {
    return { code: src };
  }
};
```

### Babel-based

Use Babel for full spec compliance (slower but more features):

```typescript
import { transform } from "@babel/standalone";

const babelTransformer: Transformer = {
  transform({ src, filename }) {
    const presets = ["env"];
    if (filename.endsWith(".tsx") || filename.endsWith(".ts")) {
      presets.push("typescript");
    }
    if (filename.endsWith(".tsx") || filename.endsWith(".jsx")) {
      presets.push("react");
    }
    const result = transform(src, {
      filename,
      presets,
      sourceType: "module",
    });
    return { code: result.code };
  }
};
```

### Composing Transformers

Chain multiple transformers together:

```typescript
function composeTransformers(...transformers: Transformer[]): Transformer {
  return {
    transform(params) {
      let result = params;
      for (const t of transformers) {
        const out = t.transform({ src: result.code ?? result.src, filename: params.filename });
        result = { ...params, ...out, src: out.code };
      }
      return { code: result.code ?? result.src };
    }
  };
}

// Example: strip types first, then add custom instrumentation
const combined = composeTransformers(typescriptTransformer, instrumentationTransformer);
```

### Extension-specific Routing

Route files to different transformers based on extension:

```typescript
const routingTransformer: Transformer = {
  transform({ src, filename }) {
    const ext = filename.slice(filename.lastIndexOf("."));
    switch (ext) {
      case ".svelte":
        return svelteTransformer.transform({ src, filename });
      case ".vue":
        return vueTransformer.transform({ src, filename });
      default:
        return typescriptTransformer.transform({ src, filename });
    }
  }
};
```

When using a routing transformer, remember to add the corresponding extensions to `resolver.sourceExts`:

```typescript
const config = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx", "svelte", "vue"] },
  transformer: routingTransformer,
  server: { packageServerUrl: "http://localhost:5200" },
};
```

## Built-in: reactRefreshTransformer

Extends `typescriptTransformer` with React Refresh support for HMR. Used in watch mode.

```typescript
import { reactRefreshTransformer } from "browser-metro";

const config = {
  resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
  transformer: reactRefreshTransformer,
  server: { packageServerUrl: "http://localhost:5200" },
  hmr: { enabled: true, reactRefresh: true },
};
```

For each `.tsx`/`.jsx` file, it:
1. Applies the same transforms as `typescriptTransformer`
2. Wraps each component with `$RefreshReg$` and `$RefreshSig$` calls
3. Appends a `module.hot.accept()` postamble so the module is an HMR accept boundary

You can also create a custom React Refresh transformer with different base transforms:

```typescript
import { createReactRefreshTransformer } from "browser-metro";

const myRefreshTransformer = createReactRefreshTransformer(myBaseTransformer);
```

## Plugin Hooks vs Transformers

Plugins and transformers serve different purposes:

| | Transformer | Plugin hooks |
|---|---|---|
| **When** | Core transform stage | Before (`transformSource`) or after (`transformOutput`) |
| **Input** | Raw source | Raw source (pre) or CJS output (post) |
| **Scope** | Every file | Per-plugin, can filter by filename |
| **Source maps** | Returns `sourceMap` | Source map offsets adjusted automatically |
| **Example** | Sucrase (TS/JSX -> CJS) | data-bx-path (inject JSX attributes) |

The plugin pipeline runs in array order. Pre-transform plugins see the original source with JSX intact, making them ideal for JSX-level transformations like attribute injection.

## Important: Output Must Be CommonJS

The bundle runtime uses CommonJS. Your transformer must ensure the output uses `require()` and `module.exports` rather than `import`/`export`. The sucrase `imports` transform handles this for the default transformer.

If your custom transformer outputs ESM, you'll need to add an import-to-CJS conversion step (e.g. sucrase's `imports` transform, or a Babel plugin like `@babel/plugin-transform-modules-commonjs`).
