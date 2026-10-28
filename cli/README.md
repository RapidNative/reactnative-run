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
`--local-packages`, `--prewarm ios[,android][,web]` (`android:seen` / `ios:seen` pre-warm a platform only once a device has asked this project for it), `--quiet`.

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

### Share one read-only cache across projects (optional)

On a host running many projects, each new one downloads the same dependency
bundles (~175MB for a typical Expo app) and worklets plugin onto its own
volume. Fill one directory on the host and mount it read-only into every
container instead:

```sh
# on the host, with the URLs many projects fetch (one per line) on stdin:
rnrun cache-fill /srv/rnrun-shared --worklets 0.13.0 --max-new 4 --prune-days 7 < urls.txt
# in each container (mounted read-only):
RNRUN_SHARED_CACHE_DIR=/shared rnrun start /app
```

rnrun reads it before its own caches and never writes to it. Only immutable
responses are taken from it (dependency bundles, preludes, exact-version
packages), so it can't serve a stale tag. Fill it from the package server
yourself, never by copying a project's cache: on a multi-tenant host that
would let one project poison every other.

### `--prewarm` vs the bundle cache

With a persistent `RNRUN_BUNDLE_CACHE_DIR`, a wake serves the cached bundle
directly, so `--prewarm` is a no-op on a warm cache (it builds only when the
cache is cold). Without a persistent cache, `--prewarm` still helps by building
during idle rather than on the first scan. The module graph needed for Fast
Refresh is built lazily on the first edit, so a cache-hit wake that only serves
bundles to a device never pays for it.

Each pre-warmed platform keeps its build session in memory (around 450MB for
a typical app). `--prewarm ios,android:seen` pre-warms Android only for
projects a device has already asked for Android: rnrun records the platforms
devices request in `platforms-<id>.json` beside the bundle cache, so the
history lasts as long as the cache does.

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
| `RNRUN_SHARED_CACHE_DIR` | — | host-filled read-only cache (`rnrun cache-fill`), read first |

## Keeping devices in step with the server

A phone holds the numeric module ids of the bundle it loaded, and RN's
HMRClient never reconnects once its `/hot` socket drops. So a dev-server
restart, a `package.json` re-init, or a patch missed while the bundle was
downloading used to leave Expo Go either silently stale or throwing
`Requiring unknown module "N"` on every edit. rnrun handles this the way
Metro's revision map does, plus an automatic reload:

- every manifest mints an `rnrunClient` token into `launchAsset.url`; the
  bundle route records which bundler session + version it served per token;
- `register-entrypoints` on `/hot` carries that URL back, and the initial
  update is the **catch-up patch** for anything the device missed (or a
  reload when it can't be patched);
- native bundles carry a tiny dev client that connects to `/__rnrun`,
  reconnects with backoff, and calls `DevSettings.reload()` when the server
  no longer serves the bundle it is running. Reloads are per device,
  rate-floored, and loop-free (a reload re-fetches the same URL, which
  updates the token's record).

Broadcast reloads (full rebuilds, re-inits) still go out on `/message`.
