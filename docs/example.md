# Example App

The example app is a Vite + React application that demonstrates browser-metro in a browser-based IDE. It provides a code editor, file tabs, a preview iframe, and a console output panel.

## Running

```bash
# From the repo root (starts all services)
npm run dev

# Or standalone (requires reactnative-esm running separately)
cd browser-metro/example
npm run dev
```

The app runs at `http://localhost:5201` (or next available port).

## Features

- **Multi-file editor** with tab switching
- **Project selector** dropdown (URL-synced via `?project=` param)
- **Live bundling** using browser-metro library
- **Watch mode with HMR** -- edit code and see changes instantly without page reload
- **React Refresh** -- preserves component state across HMR updates
- **Sandboxed execution** in dual preview iframes
- **Console capture** with color-coded log/warn/error/info output
- **Source-mapped error display** -- runtime errors show original file:line, not bundle positions
- **Rich error view** with resolved stack traces
- **TypeScript and JSX support** via the default transformer
- **data-bx-path injection** for click-to-source functionality

## Project Structure

```
example/
  index.html              # Vite entry point
  src/
    main.tsx              # React root
    App.tsx               # Main app (editor, preview iframes, console, HTML blob builder)
    App.css               # Catppuccin dark theme styles (incl. rich error display)
    bundler.worker.ts     # Web worker orchestrator (creates per-target bundler instances)
    editor-fs.ts          # EditorFS with change tracking for watch mode
    plugins/
      web-plugin.ts       # Aliases, shims, globals for web target
      expo-web.ts         # React import injection + react-native alias for Expo
  scripts/
    build-projects.ts     # Generates projects.json from user_projects/
  user_projects/          # Sample projects
    basic/                # Plain JS with lodash
    typescript/           # TypeScript project
    react/                # React app with components
  public/
    projects.json         # Generated file (gitignored)
  package.json
  vite.config.ts
  tsconfig.json
```

## How It Works

### 1. Project Loading

On startup, the app fetches `/projects.json` (generated from `user_projects/` by `build-projects.ts`). Each project is a `FileMap` keyed by absolute paths:

```json
{
  "basic": {
    "/index.js": "var _ = require('lodash');\n...",
    "/utils.js": "module.exports = function greet(name) {...}",
    "/package.json": "{\"dependencies\":{\"lodash\":\"^4.17.21\"}}"
  },
  "typescript": { ... },
  "react": { ... }
}
```

### 2. Editor

The editor is a `<textarea>` with tab key support (inserts 2 spaces). File tabs allow switching between project files. The `package.json` file is hidden from tabs since it's metadata, not editable code.

### 3. Bundling

Bundling happens in a **web worker** (`bundler.worker.ts`) to avoid blocking the UI. The worker creates `Bundler` or `IncrementalBundler` instances with target-specific plugins.

**One-shot mode** (Run button):

1. Current editor content is saved to the file map
2. Worker receives the full `FileMap` and creates a `Bundler` with `typescriptTransformer`
3. `bundler.bundle(entryFile)` walks the dependency graph, transforms files, fetches npm packages, and emits a bundle with inline source map
4. The bundle is sent back to the main thread and executed in a fresh iframe

**Watch mode** (Watch button):

1. Worker creates an `IncrementalBundler` with `reactRefreshTransformer` and does an initial full build
2. `EditorFS` tracks file changes and debounces `watch-update` messages to the worker
3. On each change, `IncrementalBundler.rebuild()` only re-transforms changed files
4. If HMR is possible, the worker sends an `hmr-update` with per-module code; otherwise it sends a full `watch-rebuild`
5. The main thread broadcasts updates to all preview iframes

### 4. Iframe Execution

The bundle runs in sandboxed iframes (`allow-scripts allow-same-origin`). Two blob URLs are created:

1. **JS Blob** -- the bundle code (preamble + runtime + modules + inline source map) as `application/javascript`
2. **HTML Blob** -- an HTML document that loads the JS blob via `<script src>` and includes console interception, a source map resolver, and error handlers

The HTML blob structure:

```
┌─ <!DOCTYPE html> ─────────────────────────────────────────┐
│ <div id="root"></div>                                      │
│                                                            │
│ <script>                                                   │
│   1. Console interception                                  │
│      Overrides console.log/warn/error/info to forward      │
│      messages to parent via postMessage                     │
│                                                            │
│   2. Source map resolver (ES5)                              │
│      - Mini VLQ decoder + decodeMappings                   │
│      - window.__SM API (init, add, resolve)                │
│      - HMR listener: extracts per-module source maps       │
│      - Stack trace parser (Chrome format)                  │
│      - window.onerror + unhandledrejection handlers        │
│        -> resolves via __SM, sends structured error        │
│           { type: 'runtime-error', message, file, line,    │
│             column, stack: [{fn,file,line,column}] }       │
│ </script>                                                  │
│                                                            │
│ <script>window.__SM.init(jsBlobUrl, sourceMapData)</script>│
│                                                            │
│ <script src="blob:...js-blob-url"></script>                │
└────────────────────────────────────────────────────────────┘
```

The parent window listens for `postMessage` events:
- `type: "console"` -- rendered as a plain log entry in the console panel
- `type: "runtime-error"` -- rendered as a rich error entry with message (red), file:line location (orange), and resolved stack frames (dimmed)
- `type: "hmr-full-reload"` -- triggers a full iframe reload when no HMR accept boundary was found

### 5. Watch Mode & HMR

Watch mode enables Hot Module Replacement:

1. **Start**: Click "Watch" -- creates an `IncrementalBundler` with React Refresh, does an initial build, and loads the bundle in iframes
2. **Edit**: Type in the editor -- `EditorFS` detects the change and sends a debounced `watch-update` to the worker
3. **Rebuild**: The worker calls `IncrementalBundler.rebuild()` which re-transforms only changed files
4. **HMR update**: The worker sends `{ type: 'hmr-update', update: { updatedModules, removedModules }, bundle }` back to the main thread
5. **Broadcast**: The main thread forwards the update to all preview iframes via `postMessage`
6. **Patch**: The iframe's HMR runtime replaces module factories, re-executes accept boundaries, and calls `performReactRefresh()`
7. **Source maps**: The iframe's HMR listener extracts per-module inline source maps from the updated code and registers them with `__SM.add()`

If no accept boundary is found, the iframe sends `hmr-full-reload` to the parent, which creates a new HTML blob from the full bundle fallback.

### 6. Project Switching

The project selector syncs with the URL via `?project=` query param:

```
http://localhost:5201/                    -> basic (default)
http://localhost:5201/?project=typescript -> typescript
http://localhost:5201/?project=react      -> react
```

Switching projects resets the editor, console, and file state.

## Adding a New Project

1. Create a directory under `example/user_projects/`:
   ```
   user_projects/myproject/
     index.ts        # Entry file
     utils.ts        # Additional files
     package.json    # { "dependencies": { ... } }
   ```

2. Restart the dev server (or run `npm run build:projects`) to regenerate `projects.json`

3. Access via `http://localhost:5201/?project=myproject`

### Project Requirements

- Must have an entry file: `index.js`, `index.ts`, `index.tsx`, or `index.jsx`
- Must have a `package.json` (can be empty: `{ "dependencies": {} }`)
- File paths are relative to the project root and prefixed with `/` in the file map
- npm dependencies listed in `package.json` are fetched from reactnative-esm at runtime

## Sample Projects

### basic

Plain JavaScript project using lodash. Demonstrates CommonJS requires and npm package fetching.

```javascript
var _ = require("lodash");
var greet = require("./utils");
console.log(greet("World"));
console.log("Shuffled:", _.shuffle([1, 2, 3, 4, 5]));
```

### typescript

TypeScript project with type annotations. Demonstrates the TypeScript transformer stripping types and converting imports.

```typescript
import { greet } from "./utils";
const name: string = "World";
console.log(greet(name));
const numbers: number[] = [1, 2, 3, 4, 5];
console.log("Doubled:", numbers.map((n: number) => n * 2));
```

### react

React application with multiple components and hooks. Demonstrates JSX transformation, npm package fetching (react, react-dom), and interactive UI in the preview iframe.

- `index.tsx` - React root with `createRoot`
- `App.tsx` - Main component with `useState`
- `Counter.tsx` - Child component with increment/decrement

## Styling

The app uses a Catppuccin Mocha dark theme with:

- Dark background (`#1e1e2e`)
- Monospace font for editor and console
- Color-coded console: default (white), warn (yellow), error (red), info (blue)
- Green "Run" button
- Blue active tab indicator
