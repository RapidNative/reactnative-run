// Platform-dimension unit tests. The load-bearing property throughout: an
// absent/web platform is BYTE-IDENTICAL to the historical platform-less
// behavior, so the ~12GB production cache is never orphaned.
//
// Run: npm test  (node --import tsx --test)

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
	SERVER_VERSION,
	normalizePlatform,
	hashDepsServer,
	cacheKeyFor,
	esbuildPlatformSettings,
	rnEsbuildSettings,
	blankedPlatformsRe,
} from "../src/platform";

test("normalizePlatform: anything unknown is web", () => {
	assert.equal(normalizePlatform(undefined), "web");
	assert.equal(normalizePlatform("web"), "web");
	assert.equal(normalizePlatform("macos"), "web");
	assert.equal(normalizePlatform(42), "web");
	assert.equal(normalizePlatform("ios"), "ios");
	assert.equal(normalizePlatform("android"), "android");
});

test("hashDepsServer: web hash is byte-identical to the historical v8 input", () => {
	const deps = { react: "19.1.0", "expo-router": "~6.0.0" };
	const subs = ["expo-router/drawer"];
	// Recompute the pre-platform formula independently.
	const sorted = Object.keys(deps).sort().map((k) => `${k}@${(deps as Record<string, string>)[k]}`).join(",");
	const legacyInput = `v${SERVER_VERSION}:${sorted};subpaths:${subs.join(",")}`;
	const legacy = crypto.createHash("sha256").update(legacyInput).digest("hex").slice(0, 16);
	assert.equal(hashDepsServer(deps, subs), legacy);
	assert.equal(hashDepsServer(deps, subs, "web"), legacy);
	assert.notEqual(hashDepsServer(deps, subs, "ios"), legacy);
	assert.notEqual(hashDepsServer(deps, subs, "ios"), hashDepsServer(deps, subs, "android"));
});

test("cacheKeyFor: web keys unchanged, native keys suffixed", () => {
	assert.equal(cacheKeyFor("react-native", "0.81.4", ""), "react-native@0.81.4");
	assert.equal(cacheKeyFor("react-native", "0.81.4", "", "web"), "react-native@0.81.4");
	assert.equal(cacheKeyFor("react-native", "0.81.4", "", "ios"), "react-native@0.81.4.ios");
	assert.equal(
		cacheKeyFor("@react-native/assets-registry", "0.81.4", "/registry", "android"),
		"@react-native__assets-registry@0.81.4__registry.android",
	);
});

test("esbuildPlatformSettings: web unchanged, native uses Metro resolution", () => {
	assert.deepEqual(esbuildPlatformSettings("web"), { platform: "browser", target: "es2020" });
	const ios = esbuildPlatformSettings("ios");
	assert.equal(ios.platform, "neutral");
	// es2018 syntax; Hermes-unsupported features (class, async arrows, block
	// scoping) are lowered by the babel post-pass, not the esbuild target.
	assert.equal(ios.target, "es2018");
	assert.deepEqual(ios.mainFields, ["react-native", "browser", "main"]);
	assert.deepEqual(ios.conditions, ["react-native"]);
});

test("rnEsbuildSettings: native has platform-first extensions and NO __DEV__ define", () => {
	const web = rnEsbuildSettings("web");
	assert.equal((web.define as Record<string, string>).__DEV__, "false");
	assert.equal(web.resolveExtensions![0], ".web.tsx");

	const android = rnEsbuildSettings("android");
	assert.equal(android.define, undefined); // binds to prelude's `var __DEV__ = true`
	assert.deepEqual(android.resolveExtensions!.slice(0, 6), [
		".android.tsx", ".android.ts", ".android.js",
		".native.tsx", ".native.ts", ".native.js",
	]);
	assert.match((android.banner as Record<string, string>).js, /development/);
});

test("blankedPlatformsRe: only OTHER platforms' files are dropped", () => {
	const ios = blankedPlatformsRe("ios");
	assert.equal(ios.test("Button.android.js"), true);
	assert.equal(ios.test("Button.windows.tsx"), true);
	assert.equal(ios.test("Button.ios.js"), false);
	assert.equal(ios.test("Button.web.js"), false);

	// Web keeps the historical blanket behavior.
	const web = blankedPlatformsRe("web");
	assert.equal(web.test("Button.android.js"), true);
	assert.equal(web.test("Button.ios.tsx"), true);
	assert.equal(web.test("Button.web.js"), false);
});
