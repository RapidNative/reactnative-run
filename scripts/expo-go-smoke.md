# Expo Go smoke test (manual)

End-to-end checklist for verifying rnrun's native pipeline against a real
Expo Go client. Run this after any change to the Metro emitter
(`browser-metro/src/metro-emit.ts`), native package builds
(`reactnative-esm` platform settings), or the manifest
(`cli/src/server/routes/native.ts`).

## Setup

1. Start the package server (or use the hosted one):

   ```sh
   cd reactnative-esm && npm start        # port 5200
   ```

2. Start rnrun on an Expo SDK project (Expo Go's installed SDK must match the
   project's `expo` major version):

   ```sh
   cd cli && npm run build
   node dist/bin.js start /path/to/app --local-packages
   ```

3. Note the printed `exp://<lan-ip>:8081` URL.

## iOS Simulator

```sh
xcrun simctl openurl booted "exp://<lan-ip>:8081"
```

(Install Expo Go in the simulator first: `npx expo start` once from any expo
project offers to install it, or drag the app from expo.dev/go.)

## Physical device

Open Expo Go, enter the `exp://` URL manually (or add a QR step).

## Checklist

- [ ] Manifest accepted: Expo Go shows the splash and starts downloading the
      bundle (a manifest error appears BEFORE any download starts).
- [ ] Boot: the app renders. (Milestone A: single-`__d` wrapper bundle.)
- [ ] Interaction: tap something stateful; state updates.
- [ ] Edit a component file: the device reloads (full reload until Fast
      Refresh lands in phase 3C) and shows the change.
- [ ] Syntax error in a route file: a red screen appears; fixing the file
      recovers after reload.
- [ ] `console.log` in the app appears in the rnrun terminal (via /logs or
      the /hot socket's log messages).
- [ ] Image asset renders (phase 3D).
- [ ] Fast Refresh preserves component state across an edit (phase 3C).

## Debugging tips

- `curl -H "expo-platform: ios" -H "Accept: multipart/mixed" http://localhost:8081/` — inspect the manifest Expo Go sees.
- `curl "http://localhost:8081/index.bundle?platform=ios" | head -c 2000` — the prelude + mini Metro runtime should be first.
- Expo Go shakes menu -> "Show developer menu" -> Reload to force a re-fetch.
- Device logs: watch the rnrun terminal for `[device:*]` lines.
