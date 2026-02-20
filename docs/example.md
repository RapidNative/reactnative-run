# Example App

The example app is a Vite + React application that demonstrates almostmetro in a browser-based IDE. It provides a code editor, file tabs, a preview iframe, and a console output panel.

## Running

```bash
# From the repo root (starts all services)
npm run dev

# Or standalone (requires almostesm running separately)
cd almostmetro/example
npm run dev
```

The app runs at `http://localhost:5173` (or next available port).

## Features

- **Multi-file editor** with tab switching
- **Project selector** dropdown (URL-synced via `?project=` param)
- **Live bundling** using almostmetro library
- **Sandboxed execution** in an iframe
- **Console capture** with color-coded log/warn/error/info output
- **TypeScript and JSX support** via the default transformer

## Project Structure

```
example/
  index.html              # Vite entry point
  src/
    main.tsx              # React root
    App.tsx               # Main app component
    App.css               # Catppuccin dark theme styles
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

When the user clicks **Run**:

1. Current editor content is saved to the file map
2. A `VirtualFS` is created from the files
3. A `Bundler` is created with the `typescriptTransformer` config
4. `bundler.bundle(entryFile)` produces the bundle string
5. The bundle is executed in a fresh iframe

### 4. Iframe Execution

The bundle runs in a sandboxed iframe (`allow-scripts` only). Before the bundle code, the iframe HTML includes a script that:

- Overrides `console.log/warn/error/info` to forward messages to the parent via `postMessage`
- Sets up `window.onerror` to capture uncaught errors
- Includes a `<div id="root">` element for React apps to mount to

The parent window listens for `postMessage` events and renders them in the console panel.

### 5. Project Switching

The project selector syncs with the URL via `?project=` query param:

```
http://localhost:5173/                    -> basic (default)
http://localhost:5173/?project=typescript -> typescript
http://localhost:5173/?project=react      -> react
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

3. Access via `http://localhost:5173/?project=myproject`

### Project Requirements

- Must have an entry file: `index.js`, `index.ts`, `index.tsx`, or `index.jsx`
- Must have a `package.json` (can be empty: `{ "dependencies": {} }`)
- File paths are relative to the project root and prefixed with `/` in the file map
- npm dependencies listed in `package.json` are fetched from almostesm at runtime

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
