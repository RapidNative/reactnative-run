# Expo Native Server (expo-server)

Part of the **almostmetro** project. A minimal Node.js server that replicates the Expo dev server protocol, serving JS bundles to Expo Go on real devices and simulators.

## Architecture

```
almostmetro/
├── browser-metro/     # Web bundler (runs in browser) - web target
├── expo-server/       # THIS: serves bundles to Expo Go via native protocol
├── reactnative-esm/   # Package manager service
└── (future) socket bridge: browser-metro → expo-server
```

**Current:** Proxy mode (forwards bundle from Metro) or standalone (WIP).
**Future:** browser-metro generates native bundle → WebSocket → expo-server → Expo Go.

## Status

- ✅ Multipart manifest endpoint (exact Expo CLI format)
- ✅ Expo Go parses manifest and requests bundle
- ✅ Bundle proxy mode: forwards to real Metro server - **full app renders**
- ✅ Standalone bundle: Metro module system works, but needs bundled React/RN
- ✅ Status, source map, and inspector stubs

## Modes

### Proxy Mode (working)
Forwards bundle requests to a real Metro server while serving its own manifest:
```bash
METRO_PROXY=http://localhost:8082 node server.js
```

### Standalone Mode (WIP)
Serves its own generated bundle. Currently blocked on bundling React/RN:
```bash
node server.js
```

## Protocol Reference

### 1. Expo Go connects to `exp://<ip>:<port>`

### 2. First request: GET /
**Headers sent by Expo Go:**
```
Accept: multipart/mixed,application/expo+json,application/json
expo-platform: ios
expo-expect-signature: sig, keyid="expo-root", alg="rsa-v1_5-sha256"
```

**Response format:** multipart/mixed
```
--formdata-<boundary>
Content-Disposition: form-data; name="manifest"
Content-Type: application/json

{manifest JSON}
--formdata-<boundary>--
```

**Response headers:**
```
Content-Type: multipart/mixed; boundary=formdata-<id>
expo-protocol-version: 0
expo-sfv-version: 0
cache-control: private, max-age=0
```

### 3. Manifest structure
```json
{
  "id": "uuid",
  "createdAt": "ISO timestamp",
  "runtimeVersion": "1.0.0",
  "launchAsset": {
    "key": "bundle",
    "contentType": "application/javascript",
    "url": "http://<host>/index.bundle?platform=ios&dev=true&..."
  },
  "assets": [],
  "metadata": {},
  "extra": {
    "expoClient": {
      "name": "App Name",
      "slug": "app-slug",
      "version": "1.0.0",
      "sdkVersion": "54.0.0",
      "platforms": ["ios", "android"],
      "hostUri": "<host>"
    },
    "expoGo": {
      "debuggerHost": "<host>",
      "developer": { "tool": "expo-cli" },
      "packagerOpts": { "dev": true },
      "mainModuleName": "index"
    }
  }
}
```

### 4. Bundle request
Expo Go fetches `launchAsset.url` and executes it as JavaScript.

### 5. Additional endpoints Expo Go requests
- `/message?role=ios` - DevTools messages (WebSocket upgrade attempt)
- `/inspector/device?name=...` - Chrome DevTools Protocol
- `/inspector/network` - Network inspector
- `/hot` - HMR WebSocket
- `/status` - Returns `packager-status:running`

## Next Steps for Standalone Mode

The challenge: `require('react')` and `require('react-native')` must resolve to actual modules. In Metro bundles, these are referenced by numeric IDs through dependency maps. Options:

1. **Pre-bundle React/RN** using a bundler (esbuild, rollup) and include in the served bundle
2. **Use browser-metro** (~/projects/almostmetro/browser-metro) to create the bundle
3. **Extract module IDs** from Expo Go's pre-loaded modules and reference them directly

## Usage

```bash
npm install
node server.js

# Open in Expo Go:
# exp://<your-ip>:8088

# Or on iOS Simulator:
# xcrun simctl openurl booted "exp://<your-ip>:8088"
```
