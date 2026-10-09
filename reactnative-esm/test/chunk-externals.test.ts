// Chunk cache keys must capture every batch member a chunk's code can reach. Observed: react-native
// subpath chunks built for an app that listed event-target-shim (react-native -> abort-controller ->
// event-target-shim) kept it external, and were then served to an app that never listed it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { basePackageName, relevantExternals } from "../src/chunk-externals";

const GRAPH: Record<string, string[]> = {
	"react-native": ["abort-controller", "invariant", "react", "@react-native/assets-registry"],
	"abort-controller": ["event-target-shim"],
	"event-target-shim": [],
	invariant: ["loose-envify"],
	"loose-envify": ["js-tokens"],
	"js-tokens": [],
	react: ["loose-envify"],
	"@react-native/assets-registry": [],
	"@react-navigation/native": ["@react-navigation/core", "react"],
	"@react-navigation/core": ["@react-navigation/routers", "react"],
	"@react-navigation/routers": ["nanoid"],
	nanoid: [],
	"cycle-a": ["cycle-b"],
	"cycle-b": ["cycle-a", "left-pad"],
	"left-pad": [],
};
const declared = (name: string) => GRAPH[name] ?? [];

test("a batch member reached through an inlined dependency counts (the observed case)", () => {
	const withShim = new Set(["react", "react-native", "event-target-shim"]);
	const without = new Set(["react", "react-native"]);
	assert.deepEqual(relevantExternals("react-native", withShim, declared), ["event-target-shim", "react"]);
	assert.deepEqual(relevantExternals("react-native", without, declared), ["react"]);
});

test("a subpath uses its base package's closure", () => {
	const batch = new Set(["react", "react-native", "event-target-shim"]);
	assert.deepEqual(relevantExternals("react-native/Libraries/Core/setUpXHR", batch, declared), [
		"event-target-shim",
		"react",
	]);
	assert.equal(basePackageName("@react-navigation/native/lib/module"), "@react-navigation/native");
	assert.equal(basePackageName("react-native/Libraries/Core/setUpXHR"), "react-native");
	assert.equal(basePackageName("left-pad"), "left-pad");
});

test("the walk stops at batch members: what they import never enters the chunk", () => {
	// @react-navigation/core is externalized, so @react-navigation/routers (and nanoid) beneath it
	// cannot affect @react-navigation/native's chunk even when they are batch members too.
	const batch = new Set(["react", "@react-navigation/core", "nanoid"]);
	assert.deepEqual(relevantExternals("@react-navigation/native", batch, declared), ["@react-navigation/core", "react"]);
});

test("a package whose closure reaches nothing extra keeps the key it had (direct batch deps only)", () => {
	const batch = new Set(["react", "@react-navigation/core"]);
	const direct = declared("@react-navigation/native").filter((d) => batch.has(d)).sort();
	assert.deepEqual(relevantExternals("@react-navigation/native", batch, declared), direct);
});

test("cycles terminate", () => {
	assert.deepEqual(relevantExternals("cycle-a", new Set(["left-pad"]), declared), ["left-pad"]);
});
