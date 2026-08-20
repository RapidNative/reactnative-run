#!/usr/bin/env node
// Pre-warm bun's global install cache with the dependency closure shared by the
// hosted preview fleet, so a project's first cold build does NOT pay to
// download these tarballs inside its per-request tmpdir. Run once at deploy
// (after `npm ci`/pull, before or just after the service starts) AS THE SERVICE
// USER, so it populates the same ~/.bun cache the server's `bun install` reads:
//
//   sudo -u <service-user> node reactnative-esm/scripts/prewarm-bun-cache.mjs
//
// It is idempotent and best-effort: already-cached tarballs are instant, and a
// single unresolvable spec is skipped rather than failing the whole warm. It
// only populates the global cache (installs into a throwaway tmpdir with
// --no-save, then deletes it) — it does not touch the server's `cache/`.
//
// Provenance of the list: the fleet-wide union of dependencies across ALL
// fullstack-supabase preview projects (2,752 projects parsed, 166 distinct
// deps; dominant version per package, relayed 2026-08-19). The ~45 core
// packages present in 2740+ projects are the shared scaffold (probably already
// warm, but included so a fresh box warms from empty); the rest are the
// "extras" present in fewer projects that are the ones most likely COLD in
// bun's cache — the @expo-google-fonts family especially. A version mismatch
// just leaves that one tarball cold, never a wrong build (the server always
// installs the project's exact pins). The v2-legacy specs the migration
// strips (@vibecode-db/client, babel-plugin-module-resolver) are omitted.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// name -> version spec (empty string = warm `latest`, best-effort where the
// fleet had no dominant pin).
const DEPS = {
	// --- Shared scaffold: Expo SDK 54 core + modules (in 2740+ projects) ---
	expo: "54.0.13",
	"@expo/html-elements": "0.12.5",
	"@expo/metro-runtime": "6.1.2",
	"@expo/vector-icons": "^14.1.0",
	"expo-clipboard": "~8.0.7",
	"expo-constants": "18.0.9",
	"expo-document-picker": "~14.0.8",
	"expo-file-system": "",
	"expo-font": "14.0.9",
	"expo-image": "3.0.9",
	"expo-image-picker": "",
	"expo-linear-gradient": "15.0.7",
	"expo-linking": "",
	"expo-location": "~18.0.9",
	"expo-print": "~15.0.5",
	"expo-router": "6.0.12",
	"expo-sharing": "~14.0.7",
	"expo-splash-screen": "31.0.10",
	"expo-sqlite": "",
	"expo-status-bar": "",
	"expo-symbols": "",
	"expo-system-ui": "",
	"expo-web-browser": "15.0.8",

	// React / React Native core
	react: "19.1.0",
	"react-dom": "19.1.0",
	"react-native": "0.81.4",
	"react-native-web": "0.21.1",

	// Recurring RN ecosystem
	"@react-native-async-storage/async-storage": "2.2.0",
	"@react-native-community/netinfo": "^11.4.1",
	"@react-native-community/slider": "5.0.1",
	"@react-native-masked-view/masked-view": "",
	"react-native-gesture-handler": "2.28.0",
	"react-native-reanimated": "4.1.3",
	"react-native-worklets": "0.5.1",
	"react-native-screens": "4.16.0",
	"react-native-svg": "15.12.0",
	"react-native-webview": "13.15.0",
	"react-native-gifted-charts": "1.4.64",
	"react-native-linear-gradient": "2.8.3",
	"react-native-web-linear-gradient": "1.1.2",

	// Navigation
	"@react-navigation/native": "7.1.18",
	"@react-navigation/bottom-tabs": "7.4.9",
	"@react-navigation/elements": "2.6.5",

	// Bottom sheet + motion
	"@gorhom/bottom-sheet": "5.0.0-alpha.11",
	"@legendapp/motion": "2.5.3",

	// Styling — nativewind stack
	nativewind: "4.2.1",
	"react-native-css-interop": "0.2.1",
	tailwindcss: "3.4.18",
	"tailwind-variants": "0.1.20",
	postcss: "^8.4.49",

	// Data / state
	"@supabase/supabase-js": "^2.90.1",
	"@tanstack/react-query": "^5.90.16",
	"@tanstack/query-async-storage-persister": "",
	"@tanstack/react-query-persist-client": "",
	zustand: "5.0.2",
	zod: "^3.25.76",
	"date-fns": "4.1.0",
	dayjs: "^1.11.13",
	"sql.js": "^1.14.0",
	xlsx: "0.18.5",
	papaparse: "5.4.1",

	// Routing (web) + react-aria stack
	"react-router": "7.8.2",
	"react-router-dom": "7.8.2",
	"react-aria": "3.44.0",
	"react-stately": "3.42.0",

	// Icons
	"lucide-react-native": "0.510.0",

	// --- Extras beyond the scaffold (present in fewer projects => most likely
	// COLD in bun's cache; these are the high-value warm targets) ---
	"expo-av": "~15.0.2",
	"expo-audio": "~1.0.7",
	"expo-video": "~2.0.6",
	"expo-camera": "~16.0.18",
	"expo-media-library": "~17.0.0",
	"expo-haptics": "~14.0.1",
	"expo-speech": "~14.0.2",
	"expo-blur": "~15.0.7",
	"expo-secure-store": "15.0.7",
	"expo-notifications": "~0.31.0",
	"expo-sensors": "~15.0.7",
	"expo-crypto": "~14.0.2",
	"expo-intent-launcher": "~13.0.6",
	"expo-keep-awake": "15.0.0",
	"expo-auth-session": "~6.1.0",
	"expo-device": "~8.0.9",
	// Deliberately NOT pre-warmed (do not re-add without a resolvable SDK-54
	// pin): expo-fetch (phantom package — the real API is `expo/fetch`, part of
	// expo core; the registry package is an empty 0.0.0 placeholder) and
	// expo-local-authentication / expo-screen-orientation (fleet data only had
	// pins from mixed older SDK eras; registry `latest` is SDK-57-era, wrong for
	// SDK 54). Rare (12 projects total) — the per-project install resolves each
	// project's real pin anyway.

	"react-native-maps": "1.20.1",
	"react-native-qrcode-svg": "^6.3.14",
	"react-native-mmkv": "3.2.0",
	"react-native-markdown-display": "7.0.2",
	"react-native-video": "^6.12.0",
	"react-native-vision-camera": "4.7.0",
	"react-native-purchases": "~10.7.1",

	"@shopify/flash-list": "1.8.0",
	"@shopify/react-native-skia": "^1.5.0",

	"@reduxjs/toolkit": "^2.6.1",
	"react-redux": "^9.2.0",

	three: "0.179.1",
	"@react-three/fiber": "8.17.10",
	"@react-three/drei": "9.122.0",

	"react-hook-form": "^7.54.2",
	"@hookform/resolvers": "^3.9.1",

	"@react-navigation/drawer": "7.3.10",
	"@react-navigation/native-stack": "^6.11.0",

	firebase: "^10.14.0",
	i18next: "^24.2.0",
	"react-i18next": "^15.4.0",

	// Google fonts family — the single highest-value warm targets (Lovable adds
	// these beyond the scaffold, so they're the ones most often cold). Exact
	// dominant pins from the fleet scan.
	"@expo-google-fonts/inter": "^0.4.1",
	"@expo-google-fonts/jetbrains-mono": "^0.4.1",
	"@expo-google-fonts/space-grotesk": "^0.4.1",
	"@expo-google-fonts/playfair-display": "^0.4.0",
	"@expo-google-fonts/plus-jakarta-sans": "^0.2.3",
	"@expo-google-fonts/manrope": "^0.4.1",
	"@expo-google-fonts/sora": "^0.4.1",
	"@expo-google-fonts/fraunces": "^0.2.3",
	"@expo-google-fonts/dm-sans": "^0.4.1",
	"@expo-google-fonts/outfit": "^0.4.1",
	"@expo-google-fonts/instrument-serif": "^0.4.1",
	"@expo-google-fonts/work-sans": "^0.2.3",
	"@expo-google-fonts/ibm-plex-mono": "^0.4.1",
	"@expo-google-fonts/ibm-plex-sans": "^0.4.1",
	"@expo-google-fonts/cairo": "^0.4.1",
	"@expo-google-fonts/anton": "^0.4.2",
	"@expo-google-fonts/poppins": "^0.2.3",
	"@expo-google-fonts/vazirmatn": "^0.2.3",
	"@expo-google-fonts/raleway": "^0.4.1",
	"@expo-google-fonts/jost": "^0.4.0",
	"@expo-google-fonts/montserrat": "^0.4.1",
	"@expo-google-fonts/dm-serif-display": "^0.4.2",
	"@expo-google-fonts/roboto-slab": "^0.4.2",
};

// A handful of packages pinned two versions across the fleet — warm both so
// neither project variant pays a cold download.
const EXTRA_VERSIONS = [
	"react-native-safe-area-context@5.6.1",
	"react-native-safe-area-context@5.7.0",
	"react-native-svg@^15.15.1",
	"@legendapp/motion@2.4.0",
];

function specFor(name, ver) {
	return ver ? `${name}@${ver}` : name;
}

async function bunInstall(specs, cwd) {
	// --no-save + a throwaway cwd: we only want the side effect of populating
	// bun's GLOBAL cache. --no-progress keeps the log readable in CI/deploy.
	await execFileAsync("bun", ["install", "--no-progress", "--no-save", ...specs], {
		cwd,
		timeout: 15 * 60 * 1000,
		maxBuffer: 64 * 1024 * 1024,
	});
}

async function main() {
	const allSpecs = [
		...Object.entries(DEPS).map(([n, v]) => specFor(n, v)),
		...EXTRA_VERSIONS,
	];
	const dir = mkdtempSync(join(tmpdir(), "rnrun-prewarm-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rnrun-prewarm", version: "1.0.0" }));

	console.log(`[prewarm] warming bun global cache with ${allSpecs.length} specs in ${dir}`);
	const start = Date.now();
	try {
		try {
			await bunInstall(allSpecs, dir);
			console.log(`[prewarm] batch install ok in ${Date.now() - start}ms`);
		} catch (err) {
			// One bad spec fails the whole batch (bun is all-or-nothing). Fall
			// back to warming each spec on its own so a single unresolvable
			// version can't leave the rest of the closure cold.
			console.warn(`[prewarm] batch failed (${String(err?.message || err).slice(0, 160)}) — warming individually`);
			let ok = 0;
			let failed = 0;
			for (const spec of allSpecs) {
				try {
					await bunInstall([spec], dir);
					ok++;
				} catch (e) {
					failed++;
					console.warn(`[prewarm] skip ${spec}: ${String(e?.message || e).slice(0, 120)}`);
				}
			}
			console.log(`[prewarm] individual warm done: ${ok} ok, ${failed} skipped, ${Date.now() - start}ms`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log(`[prewarm] complete in ${Date.now() - start}ms`);
}

main().catch((e) => {
	console.error(`[prewarm] fatal: ${e?.stack || e}`);
	process.exit(1);
});
