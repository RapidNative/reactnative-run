# CLAUDE.md

## Project overview

browser-metro is a browser-based JavaScript/TypeScript bundler with HMR support, mirroring Metro (React Native's bundler) in simplified form. It runs entirely in the browser using Web Workers.

- `browser-metro/` -- the core bundler library (VirtualFS, Resolver, Bundler, IncrementalBundler, HMR runtime)
- `reactnative-esm/` -- Express server that bundles npm packages on-demand via esbuild
- `browser-metro/example/` -- Vite-based demo app with editor, preview iframes, and console

## Key commands

- `cd browser-metro && npm run build` -- compile the library (tsc). Required after editing `browser-metro/src/`.
- `cd browser-metro/example && npm run dev` -- start the example app (Vite dev server on port 5201)
- `cd reactnative-esm && npm start` -- start the package server on port 5200

## Architecture documentation

Detailed architecture docs live in `docs/architecture.md`. Key sections:
- Data flow (project loading, VirtualFS, resolution, transformation, bundling)
- Plugin system and transformer pipeline
- HMR end-to-end flow and runtime
- Expo Router HMR for dynamic route addition (split entry architecture, reverse deps updates, cache clearing order)
- Expo API Routes (`+api.ts` files) -- separate API bundle with in-browser fetch interception
- Source maps
- npm package bundling via reactnative-esm

## Important patterns

- **VirtualFS**: All file operations go through the in-memory VirtualFS. The bundler never touches the real filesystem.
- **EditorFS** (`example/src/editor-fs.ts`): Wraps VirtualFS with dirty tracking and debounced flushes to the bundler worker.
- **Synthetic entry for expo-router**: When `package.json` has `"main": "expo-router/entry"`, the bundler generates `/__expo_ctx.js` (route map) and `/index.tsx` (entry). See `docs/architecture.md` "Expo Router: HMR for dynamic route addition" for details on why these are split.
- **HMR Phase 5 cache clearing**: All module caches are cleared before any re-execution to prevent stale requires from ordering bugs (`hmr-runtime.ts`).
- **API Routes**: Files ending with `+api.ts` under `/app/` are bundled separately and served in-browser via a fetch interceptor. They are excluded from the client route context. See `docs/architecture.md` "Expo API Routes".

## Patching package sources (reactnative-esm)

Two esbuild `onLoad` plugins in `reactnative-esm/src/index.ts` rewrite package sources as they are bundled:

- **`patchUpstreamBugsPlugin`** -- fixes upstream bugs. Currently normalises a partial `edges` prop in `react-native-safe-area-context`'s web `SafeAreaView` (only needed below 5.7.0; upstream fixed it there).
- **`previewShimsPlugin`** -- makes web builds publish state the RapidNative editor needs. Currently shims `expo-status-bar`, which is otherwise a no-op on web, so the editor's simulated status bar can follow `<StatusBar style="..." />`.

Conventions when adding to either:

- Register on **all three** `esbuild.build` plugin arrays, otherwise a subpath import bypasses the patch.
- Anchor on something specific and **log-and-skip** (`return null`) if the anchor is missing, so an upstream refactor cannot silently ship an unpatched or clobbered build.
- Prefer wrapping over replacing. Re-export through the original module and add behaviour, rather than substituting an implementation.
- **Check which file actually gets loaded.** If a package's `exports` map names an exact path (e.g. `"./src/StatusBar.ts"`), that bypasses `resolveExtensions` entirely and the `.web.*` variant is never resolved -- patching it compiles fine and does nothing.
- Verify against the **served bundle**, never the source on disk.

## Cache invalidation (reactnative-esm)

`reactnative-esm` writes bundles to `cache/` and serves them on later requests, so **after changing bundling logic the affected entries must be evicted or the change ships inert.** There are two layers, and they are easy to get wrong:

1. **Per-package** -- `cache/<pkg>@<version>.js` plus its `.externals.json`, for every affected version.
2. **Combined dep bundles** -- `cache/bundle-deps-*.js` that inline the package. This is the layer clients usually request, so skipping it makes a change appear deployed while nothing actually changes. Find them by grepping for a symbol from the package and excluding your own patch marker.

`cacheKeyFor()` deliberately omits `SERVER_VERSION` -- see its `KNOWN GAP` comment. Versioning the key was tried and reverted, because prefixing every key orphans the entire cache at once and forces every package to rebuild on demand. The consequence is that **bumping `SERVER_VERSION` does not invalidate per-package entries**; eviction is manual.

`SERVER_VERSION` (`reactnative-esm/src/index.ts`) must stay equal to `DEPS_HASH_VERSION` (`browser-metro/src/utils.ts`). Bumping it only affects the multi-package deps hash, and only once a client build carrying the new value ships -- the client computes that hash, so a bump cannot fix stale bundles by itself.

Verify a change by fetching from a running server (`npm start`, port 5200) and grepping the response, not by reading the source.
