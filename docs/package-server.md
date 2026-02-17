# Package Server

The package server is an Express service that bundles npm packages on-demand for browser consumption. It follows an unpkg-style URL scheme and caches results to disk.

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
2. **Check disk cache** - if cached, serve immediately
3. **Create temp directory** and run `npm init -y && npm install <package>@<version>`
4. **Read peer dependencies** from the installed package's `package.json`
5. **Create entry file**: `module.exports = require("<package><subpath>");`
6. **Bundle with esbuild**:
   - Format: IIFE (assigns to `__module`)
   - Platform: browser
   - Target: ES2020
   - External: peer dependencies (prevents duplicate instances)
7. **Wrap output** to expose `module.exports`
8. **Cache to disk** and serve

### Peer Dependency Handling

Peer dependencies are marked as `external` during esbuild bundling. This means they remain as `require()` calls in the output rather than being inlined.

This is critical for packages like `react-dom` which declares `react` as a peer dependency. Without externalization, `react-dom` would bundle its own copy of React, causing the "multiple copies of React" error when hooks are used.

The bundled output's `require()` calls are resolved by almostmetro's bundle runtime, which shares a single module cache across all modules. This ensures `react-dom` and user code both get the same React instance.

## Response Format

The server returns `application/javascript` content. The output structure:

```javascript
// Bundled: react-dom/client@latest
// Peers: react
var __module = (() => {
  // ... esbuild IIFE bundle (peer deps remain as require() calls) ...
})();
module.exports = typeof __module !== "undefined" ? (__module.default || __module) : {};
```

The `module.exports` assignment at the end makes the output compatible with almostmetro's CommonJS module wrapper. When this code runs inside `function(module, exports, require) { ... }`, it properly sets `module.exports` to the package's public API.

## Caching

Bundled packages are cached to `package-server/cache/` as `.js` files:

```
cache/
  lodash@latest.js
  lodash@4.17.21.js
  react@latest.js
  react-dom@latest__client.js    # subpath "/" replaced with "__"
```

To force a rebuild, delete the specific cache file and re-request.

To clear all cached packages:
```bash
rm -rf package-server/cache/*.js
```

## Configuration

The server runs on port 3001 by default. The port is defined in `package-server/src/index.ts`.

CORS is enabled for all origins (`Access-Control-Allow-Origin: *`) so the browser-based bundler can fetch packages from any origin.

## Running

```bash
# Development (with auto-reload)
npm run dev --prefix package-server

# Production
npm start --prefix package-server
```

## Integration with almostmetro

The bundler connects to the package server via the `server.packageServerUrl` config:

```typescript
const config: BundlerConfig = {
  // ...
  server: { packageServerUrl: "http://localhost:3001" },
};
```

When the bundler encounters an npm `require()` (i.e. not starting with `.` or `/`), it fetches the pre-bundled package:

```
require("lodash") -> GET http://localhost:3001/pkg/lodash
require("react-dom/client") -> GET http://localhost:3001/pkg/react-dom/client
```
