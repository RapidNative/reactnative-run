# almostesm

almostesm is an Express service that bundles npm packages on-demand for browser consumption. It follows an unpkg-style URL scheme and caches results to disk.

## URL Format

```
GET /pkg/<package>[@<version>][/<subpath>]
```

### Examples

| URL | Package | Version | Subpath | require() |
|---|---|---|---|---|
| `/pkg/lodash` | lodash | latest | - | `require("lodash")` |
| `/pkg/lodash@4.17.21` | lodash | 4.17.21 | - | `require("lodash")` |
| `/pkg/react-dom/client` | react-dom | latest | /client | `require("react-dom/client")` |
| `/pkg/react-dom@19/client` | react-dom | 19 | /client | `require("react-dom/client")` |
| `/pkg/@scope/name` | @scope/name | latest | - | `require("@scope/name")` |
| `/pkg/@scope/name@1.0/sub` | @scope/name | 1.0 | /sub | `require("@scope/name/sub")` |

## How It Works

When a package is requested for the first time:

1. **Parse** the URL into package name, version, and optional subpath
2. **Check disk cache** -- if cached, serve immediately (with externals header)
3. **Create temp directory** and run `npm init -y && npm install <package>@<version>`
4. **Read package metadata** from the installed package's `package.json` to collect all `dependencies` + `peerDependencies` as externals
5. **Detect React Native/Expo packages** by checking the package name and keywords
6. **Create entry file**: `module.exports = require("<package><subpath>");`
7. **Bundle with esbuild** using the selective external plugin (see below)
8. **Wrap output** with `module.exports = __module`
9. **Cache to disk** (both the `.js` bundle and `.externals.json` manifest)
10. **Return response** with `X-Externals` header

## Dependency Externalization

All `dependencies` and `peerDependencies` of a package are externalized during esbuild bundling. This means they remain as `require()` calls in the output rather than being inlined. This ensures shared transitive deps (e.g. `@react-navigation/core` used by multiple navigation packages) are loaded once at runtime.

### Selective External Plugin

Not all imports are externalized equally:

- **Bare imports** (e.g. `require("react")`) -- always externalized if the package is in the externals set
- **Subpath imports of react/react-dom/react-native** (e.g. `require("react-dom/client")`) -- always externalized to avoid inlining version-sensitive code from the temp dir
- **Other subpath imports** (e.g. `require("css-in-js-utils/lib/foo")`) -- try to resolve locally first; only externalize if resolution fails. This prevents interop issues with CJS subpath modules.

### Version Pinning via X-Externals Header

When almostesm bundles a package, it tracks the installed versions of all externalized dependencies. This information is returned as the `X-Externals` response header:

```
X-Externals: {"react":"19.1.0","react-dom":"19.1.0","memoize-one":"4.1.0"}
```

The almostmetro bundler reads this header and uses the pinned versions when fetching transitive dependencies, instead of defaulting to `@latest`. This prevents version mismatches where a transitive dep gets a different version than what the parent package was built against.

**Version resolution priority in the bundler:**
1. User's `package.json` version (explicit user constraint always wins)
2. Transitive dep version from `X-Externals` manifest (pinned by parent)
3. Bare name / latest (fallback)

### React Native / Expo Package Handling

Packages are detected as React Native/Expo when:
- Package name starts with `@expo/`
- Package name contains `react-native`
- Package keywords include `react-native` or `expo`

For these packages, esbuild gets additional config:
- **Resolve extensions**: `.web.tsx`, `.web.ts`, `.web.js` prioritized (for web-specific implementations)
- **Loaders**: `.js` treated as JSX, fonts/images as data URLs
- **Banner**: Injects `process.env` and React global
- **Defines**: `__DEV__` set to `false`
- **Extra externals**: `react-native`, `react`, `react-dom` always externalized (many RN packages use these without listing them as deps)

## Response Format

The server returns `application/javascript` content. The output structure:

```javascript
// Bundled: react-dom/client@19.1.0
// Externals: react
var __module = (() => {
  // ... esbuild IIFE bundle (externalized deps remain as require() calls) ...
})();
if (typeof __module !== "undefined") { module.exports = __module; }
```

The IIFE wrapper is deliberately simple (`module.exports = __module`). Both Sucrase (user code transformer) and esbuild (package bundler) generate interop helpers (`_interopRequireDefault` / `__toESM`) that correctly handle all export types -- ESM namespace objects, CJS objects, and CJS function exports. A more complex wrapper that tries to unwrap `.default` breaks CJS modules that export functions directly.

## Caching

Bundled packages are cached to `almostesm/cache/` with two files per package:

```
cache/
  lodash@4.17.21.js              # the bundled JavaScript
  lodash@4.17.21.externals.json  # {"dep": "1.0.0", ...} externals manifest
  react-dom@19.1.0__client.js    # subpath "/" replaced with "__"
  react-dom@19.1.0__client.externals.json
```

Cache hits also send the `X-Externals` header (read from the `.externals.json` file).

To force a rebuild, delete both the `.js` and `.externals.json` files and re-request.

To clear all cached packages:
```bash
rm -f almostesm/cache/*.js almostesm/cache/*.json
```

## Configuration

The server runs on port 5200 by default. The port is defined in `almostesm/src/index.ts`.

CORS is enabled for all origins (`Access-Control-Allow-Origin: *`) with `X-Externals` exposed via `Access-Control-Expose-Headers`.

## Running

```bash
# Development (with auto-reload)
npm run dev --prefix almostesm

# Production
npm start --prefix almostesm
```

## Integration with almostmetro

The bundler connects to almostesm via the `server.packageServerUrl` config:

```typescript
const config: BundlerConfig = {
  // ...
  server: { packageServerUrl: "http://localhost:5200" },
};
```

When the bundler encounters an npm `require()` (i.e. not starting with `.` or `/`), it fetches the pre-bundled package:

```
require("lodash") -> GET http://localhost:5200/pkg/lodash@4.17.21
require("react-dom/client") -> GET http://localhost:5200/pkg/react-dom@19.1.0/client
```

The bundler resolves versions from the user's `package.json` first, then from transitive dependency manifests (`X-Externals`), before falling back to bare names.

In the Vite example app, `localhost:5201/pkg/*` is proxied to `localhost:5200/pkg/*` -- they hit the same server.
