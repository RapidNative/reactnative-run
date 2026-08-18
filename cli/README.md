# rnrun

A drop-in replacement for the Expo dev server with a tiny memory footprint.
Packages come pre-bundled from `esm.reactnative.run`, so there is no Metro and
no `node_modules` to install for most projects.

```sh
npm install -g rnrun
cd my-expo-app
rnrun start
```

Open the printed `exp://` URL in Expo Go (iOS/Android) or the web URL in a
browser. Web has live HMR; native has Fast Refresh.

## Commands

```
rnrun start [dir]              start the dev server (default command)
rnrun bundle [dir] [--out f]   one-shot bundle
rnrun help
```

`start` flags: `--port`, `--host lan|localhost`, `--package-server <url>`,
`--local-packages`, `--prewarm ios[,android][,web]`, `--quiet`.

## Running in a container / hosted preview

rnrun is designed to run one project per container that scales to zero. Two
things matter there, and both are the difference between a multi-second and a
sub-second wake.

### Persist the caches on a mounted volume

rnrun caches on disk under `$HOME/.rnrun` by default. On most container
runtimes `$HOME` is the **writable layer, which is wiped on stop/start** — so
the caches never survive a wake and every wake rebuilds. Under gVisor and other
sandboxed or `--read-only` runtimes this is silent. Point the caches at a
persistent volume:

| Env var | What it persists | Effect if ephemeral |
|---|---|---|
| `RNRUN_BUNDLE_CACHE_DIR` | assembled bundles | wake rebuilds (30–90s → ~0.5s when persisted) |
| `RNRUN_TOOLS_DIR` | the reanimated worklets plugin | plugin re-fetched every wake |
| `RNRUN_PKG_CACHE_DIR` | pre-bundled packages | packages re-fetched every wake |

```sh
RNRUN_BUNDLE_CACHE_DIR=/data/rnrun/bundles \
RNRUN_TOOLS_DIR=/data/rnrun/tools \
RNRUN_PKG_CACHE_DIR=/data/rnrun/pkg \
  rnrun start /app
```

rnrun prints a warning at startup if the bundle cache is on an ephemeral
filesystem (overlay/tmpfs), so a misconfiguration is visible rather than silent.

### Pre-bake the worklets plugin (optional)

If a project uses `react-native-reanimated`, rnrun fetches its babel plugin on
first use. To keep that off the startup path, bake it into the image and point
at it:

```sh
RNRUN_WORKLETS_PLUGIN=/opt/rnrun/react-native-worklets/plugin rnrun start /app
```

### `--prewarm` vs the bundle cache

With a persistent `RNRUN_BUNDLE_CACHE_DIR`, a wake serves the cached bundle
directly, so `--prewarm` is a no-op on a warm cache (it builds only when the
cache is cold). Without a persistent cache, `--prewarm` still helps by building
during idle rather than on the first scan. The module graph needed for Fast
Refresh is built lazily on the first edit, so a cache-hit wake that only serves
bundles to a device never pays for it.

## Cache env reference

| Var | Default | Purpose |
|---|---|---|
| `RNRUN_BUNDLE_CACHE_DIR` | `$HOME/.rnrun/bundle-cache` | assembled-bundle cache |
| `RNRUN_BUNDLE_CACHE_MAX` | `8` | max cached bundles (LRU) |
| `RNRUN_NO_BUNDLE_CACHE` | — | disable the bundle cache |
| `RNRUN_TOOLS_DIR` | `$HOME/.rnrun/tools` | fetched build tools (worklets plugin) |
| `RNRUN_WORKLETS_PLUGIN` | — | explicit path to the worklets babel plugin |
| `RNRUN_PKG_CACHE_DIR` | `$HOME/.rnrun/pkg-cache` | package-response cache |
| `RNRUN_NO_PKG_CACHE` | — | disable the package-response cache |
