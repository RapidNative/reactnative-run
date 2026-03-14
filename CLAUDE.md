# CLAUDE.md

## Project overview

almostmetro is a browser-based JavaScript/TypeScript bundler with HMR support, mirroring Metro (React Native's bundler) in simplified form. It runs entirely in the browser using Web Workers.

- `almostmetro/` -- the core bundler library (VirtualFS, Resolver, Bundler, IncrementalBundler, HMR runtime)
- `almostesm/` -- Express server that bundles npm packages on-demand via esbuild
- `almostmetro/example/` -- Vite-based demo app with editor, preview iframes, and console

## Key commands

- `cd almostmetro && npm run build` -- compile the library (tsc). Required after editing `almostmetro/src/`.
- `cd almostmetro/example && npm run dev` -- start the example app (Vite dev server on port 5201)
- `cd almostesm && npm start` -- start the package server on port 5200

## Architecture documentation

Detailed architecture docs live in `docs/architecture.md`. Key sections:
- Data flow (project loading, VirtualFS, resolution, transformation, bundling)
- Plugin system and transformer pipeline
- HMR end-to-end flow and runtime
- Expo Router HMR for dynamic route addition (split entry architecture, reverse deps updates, cache clearing order)
- Source maps
- npm package bundling via almostesm

## Important patterns

- **VirtualFS**: All file operations go through the in-memory VirtualFS. The bundler never touches the real filesystem.
- **EditorFS** (`example/src/editor-fs.ts`): Wraps VirtualFS with dirty tracking and debounced flushes to the bundler worker.
- **Synthetic entry for expo-router**: When `package.json` has `"main": "expo-router/entry"`, the bundler generates `/__expo_ctx.js` (route map) and `/index.tsx` (entry). See `docs/architecture.md` "Expo Router: HMR for dynamic route addition" for details on why these are split.
- **HMR Phase 5 cache clearing**: All module caches are cleared before any re-execution to prevent stale requires from ordering bugs (`hmr-runtime.ts`).
