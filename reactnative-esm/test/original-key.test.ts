// browser-metro keeps an overridden package's real code under "<name>__original".
// When a client asks the server for that key as a package name, the server must
// serve the real package, not npm-install a name that doesn't exist (HTTP 500,
// "Failed to fetch package 'expo-sensors__original@^58.0.0'", Nov 2026).

import { test } from "node:test";
import assert from "node:assert/strict";
import { originalPackageName } from "../src/original-key";

test("maps a synthetic __original package name to the real one", () => {
	assert.equal(originalPackageName("expo-sensors__original"), "expo-sensors");
	assert.equal(originalPackageName("@scope/lib__original"), "@scope/lib");
});

test("leaves real names and degenerate keys alone", () => {
	assert.equal(originalPackageName("expo-sensors"), "expo-sensors");
	assert.equal(originalPackageName("__original"), "__original");
	assert.equal(originalPackageName("@scope/__original"), "@scope/__original");
});
