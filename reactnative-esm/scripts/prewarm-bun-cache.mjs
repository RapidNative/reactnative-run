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
// Provenance of the list: the union of dependencies across the migrated
// jetplane->rnrun projects' mobile package.json (relayed 2026-08-19). Versions
// are pinned where the projects agreed on one; entries WITHOUT a pin (the
// @expo-google-fonts family and a few Expo SDK modules) warm at `latest` as a
// best-effort — a version mismatch just means that one tarball isn't warmed,
// never a wrong build (the server always installs the project's exact pins).
// The v2-legacy specs the migration strips (@vibecode-db/client,
// babel-plugin-module-resolver) are intentionally omitted.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// name -> version spec (empty string = warm `latest`, best-effort).
const DEPS = {
	// Expo SDK 54 core + modules (mostly already warm — shared by every project)
	expo: "54.0.13",
	"@expo/html-elements": "0.12.5",
	"@expo/metro-runtime": "6.1.2",
	"expo-clipboard": "",
	"expo-constants": "18.0.9",
	"expo-document-picker": "",
	"expo-file-system": "",
	"expo-font": "14.0.9",
	"expo-image": "3.0.9",
	"expo-image-picker": "",
	"expo-linear-gradient": "15.0.7",
	"expo-linking": "",
	"expo-local-authentication": "",
	"expo-location": "",
	"expo-print": "",
	"expo-router": "6.0.12",
	"expo-sharing": "",
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

	// Data / state
	"@supabase/supabase-js": "^2.90.1",
	"@tanstack/react-query": "^5.90.16",
	"@tanstack/query-async-storage-persister": "",
	"@tanstack/react-query-persist-client": "",
	zustand: "5.0.2",
	zod: "^3.25.76",
	"date-fns": "4.1.0",
	"sql.js": "^1.14.0",
	xlsx: "0.18.5",

	// Routing (web) + react-aria stack
	"react-router": "7.8.2",
	"react-router-dom": "7.8.2",
	"react-aria": "3.44.0",
	"react-stately": "3.42.0",

	// Icons
	"lucide-react-native": "0.510.0",

	// Google fonts family — the highest-value warm targets (Lovable adds these
	// beyond the shared scaffold, so they're the ones most often cold).
	"@expo-google-fonts/cairo": "",
	"@expo-google-fonts/fraunces": "",
	"@expo-google-fonts/instrument-serif": "",
	"@expo-google-fonts/inter": "",
	"@expo-google-fonts/jetbrains-mono": "",
	"@expo-google-fonts/manrope": "",
	"@expo-google-fonts/outfit": "",
	"@expo-google-fonts/plus-jakarta-sans": "",
	"@expo-google-fonts/sora": "",
	"@expo-google-fonts/space-grotesk": "",
	"@expo-google-fonts/work-sans": "",
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
