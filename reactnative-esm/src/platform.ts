import crypto from "crypto";
import type esbuild from "esbuild";

// Bump this when the bundling logic changes to invalidate all caches.
// Must match DEPS_HASH_VERSION in browser-metro/src/utils.ts.
export const SERVER_VERSION = "8";
// Must stay equal to NATIVE_DEPS_VERSION in browser-metro/src/utils.ts.
export const NATIVE_DEPS_VERSION = "2";

// ============================================================
// Platform dimension (web | ios | android)
//
// Everything platform-related is ADDITIVE: an absent/unknown platform is
// "web" and produces byte-identical behavior (URLs, cache keys, hashes) to
// the platform-less server, so the existing production cache stays valid.
// ============================================================

export type BuildPlatform = "web" | "ios" | "android";

export function normalizePlatform(raw: unknown): BuildPlatform {
	return raw === "ios" || raw === "android" ? raw : "web";
}

export function hashDepsServer(deps: Record<string, string>, subpaths: string[] = [], platform: BuildPlatform = "web"): string {
	const sorted = Object.keys(deps).sort().map(k => `${k}@${deps[k]}`).join(",");
	const subs = subpaths.length ? `;subpaths:${[...subpaths].sort().join(",")}` : "";
	// Non-web only, byte-identical to hashDeps in browser-metro/src/utils.ts
	// (including NATIVE_DEPS_VERSION -- see that file for bump rules).
	const plat = platform !== "web" ? `;platform=${platform};nv=${NATIVE_DEPS_VERSION}` : "";
	const input = `v${SERVER_VERSION}:${sorted}${subs}${plat}`;
	return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function cacheKeyFor(pkgName: string, version: string, subpath: string, platform: BuildPlatform = "web"): string {
	// KNOWN GAP: SERVER_VERSION is deliberately NOT part of this key.
	//
	// The comment on SERVER_VERSION says bumping it invalidates all caches, but
	// only the multi-package deps hash actually includes it — these per-package
	// bundles (the common case) keep serving pre-change output across a bump. So
	// after changing bundling logic you must also evict the affected entries from
	// `cache/` by hand, or the change ships inert.
	//
	// Adding the version here was tried and reverted: production's cache is ~12GB,
	// so prefixing every key orphans all of it at once, forcing every package to
	// rebuild on demand and roughly doubling disk until the old files are removed.
	// That is too blunt to carry a small source patch. Fix this properly alongside
	// a planned cache rebuild, not as a side effect.
	//
	// PLATFORM: appended ONLY for non-web platforms, so every existing web key
	// (the entire production cache) is untouched. Native entries live in a new
	// key namespace (e.g. "react-native@0.81.4.ios.js") from day one.
	const plat = platform && platform !== "web" ? `.${platform}` : "";
	return `${pkgName.replace(/\//g, "__")}@${version}${subpath.replace(/\//g, "__")}${plat}`;
}

/** Base esbuild resolution settings per platform. Native uses Metro's
 *  resolution order: mainFields react-native > browser > main, condition
 *  "react-native", and es2017 output for Hermes. */
export function esbuildPlatformSettings(platform: BuildPlatform): Partial<esbuild.BuildOptions> {
	if (platform === "web") {
		return { platform: "browser", target: "es2020" };
	}
	return {
		platform: "neutral",
		// Hermes supports most of ES2018 (async, generators, spread, ?.)
		// but NOT class syntax -- verified with RN 0.81's hermesc, which
		// rejects `class {}` with "Invalid expression encountered". esbuild
		// cannot lower class syntax itself ("not supported yet"), so native
		// chunk output goes through a babel post-pass (lowerClassesForHermes)
		// that runs @babel/plugin-transform-classes over the bundled result.
		target: "es2018",
		mainFields: ["react-native", "browser", "main"],
		conditions: ["react-native"],
	};
}

/** The RN/Expo-conditional esbuild settings per platform.
 *  Web keeps the historical settings verbatim (cache compatibility).
 *  Native: platform/native extensions first, NO `__DEV__` define -- the
 *  identifier stays free so it binds to the bundle prelude's `var __DEV__`,
 *  keeping dev features (LogBox, warnings) alive in Expo Go. */
export function rnEsbuildSettings(platform: BuildPlatform): Partial<esbuild.BuildOptions> {
	if (platform === "web") {
		return {
			resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
			loader: { ".js": "jsx", ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl" },
			banner: { js: "var process = { env: { NODE_ENV: 'production' } }; var React = require('react');" },
			define: { "__DEV__": "false" },
		};
	}
	return {
		resolveExtensions: [
			`.${platform}.tsx`, `.${platform}.ts`, `.${platform}.js`,
			".native.tsx", ".native.ts", ".native.js",
			".tsx", ".ts", ".js", ".json",
		],
		loader: { ".js": "jsx", ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl" },
		banner: { js: "var process = { env: { NODE_ENV: 'development' } }; var React = require('react');" },
	};
}

/** Regex of platform-suffixed files to BLANK for a given target platform:
 *  only the OTHER platforms' files are dropped (an ios build keeps .ios
 *  files, drops .android and .windows ones). Web keeps the historical
 *  behavior of dropping all three. */
export function blankedPlatformsRe(platform: BuildPlatform): RegExp {
	const blanked = ["android", "ios", "windows"].filter((p) => p !== platform);
	return new RegExp(`\\.(${blanked.join("|")})\\.[jt]sx?$`);
}
