import type { BundlerPlugin } from "../types.js";

/**
 * NOTE — no Expo packages are shimmed here anymore.
 *
 * `expo-modules-core` is intentionally NOT shimmed: it used to be replaced with
 * an inline web shim, but that was a mistake — it's the foundation every Expo
 * native module builds on, its public surface is large and central, and any gap
 * breaks a downstream package at runtime (e.g. expo-image's `<Image>` crashed on
 * a missing `createSnapshotFriendlyRef`). It resolves to its real web build
 * through the package server instead.
 *
 * `expo-speech-recognition` was previously shimmed (it predated the package's
 * web support), but it now ships a real web build (`*.web.js` wrapping the
 * browser Web Speech API). Since the package server's platform resolution
 * prefers `.web.*`, it resolves to that real build — no shim needed.
 *
 * This plugin is kept as a registered no-op so consumers that list it in their
 * plugin array keep working, and so future Expo-specific shims have a home.
 */
export function createExpoWebShimsPlugin(): BundlerPlugin {
  return {
    name: "expo-web-shims",
    shimModules() {
      return {};
    },
  };
}
