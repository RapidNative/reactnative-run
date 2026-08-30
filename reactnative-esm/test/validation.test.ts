import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPackageName, isValidVersionRange } from "../src/validation";

// These validators are the first line of defense against the OS command
// injection that was exploited in production (a package name interpolated into
// `npm install '<name>@<ver>'`). The injection payloads below MUST be rejected.

test("isValidPackageName accepts canonical npm names", () => {
	for (const ok of [
		"lodash",
		"react",
		"react-native",
		"react-dom",
		"@scope/name",
		"@react-native/masked-view",
		"@react-native-async-storage/async-storage",
		"@expo-google-fonts/inter",
		"lodash.merge",
		"a",
		"@a/b",
	]) {
		assert.equal(isValidPackageName(ok), true, `should accept ${ok}`);
	}
});

test("isValidPackageName rejects command-injection payloads", () => {
	for (const bad of [
		"react;id",
		"x';id 1>&2;'",
		"x';id;'",
		"react$(id)",
		"react`id`",
		"react|id",
		"react&id",
		"react>foo",
		"a b",
		"react\nid",
		"react\x00id",
		"'",
		"$(touch /tmp/x)",
	]) {
		assert.equal(isValidPackageName(bad), false, `should reject ${JSON.stringify(bad)}`);
	}
});

test("isValidPackageName rejects path traversal, flags, uppercase, overlong, non-strings", () => {
	assert.equal(isValidPackageName("../etc/passwd"), false);
	assert.equal(isValidPackageName("../../root"), false);
	assert.equal(isValidPackageName("-rf"), false, "must not look like an npm flag");
	assert.equal(isValidPackageName("--registry=http://evil"), false);
	assert.equal(isValidPackageName("React"), false, "npm names are lowercase");
	assert.equal(isValidPackageName("a".repeat(215)), false, "over 214 chars");
	assert.equal(isValidPackageName(""), false);
	assert.equal(isValidPackageName(undefined), false);
	assert.equal(isValidPackageName(null), false);
	assert.equal(isValidPackageName(42), false);
	assert.equal(isValidPackageName(".hidden"), false, "must start alphanumeric");
	assert.equal(isValidPackageName("_priv"), false);
});

test("isValidVersionRange accepts exact versions, ranges and dist-tags", () => {
	for (const ok of [
		"1.2.3",
		"19.1.0",
		"0.81.4",
		"^1.2.3",
		"~2.0.0",
		">=1.0.0",
		"1.x",
		"*",
		"latest",
		"next",
		"5.0.0-alpha.11",
		"^15.15.1",
		">=1.0.0 <2.0.0",
	]) {
		assert.equal(isValidVersionRange(ok), true, `should accept ${ok}`);
	}
});

test("isValidVersionRange rejects command-injection payloads", () => {
	for (const bad of [
		"latest;id",
		"1.0.0';id;'",
		"$(id)",
		"`id`",
		"1.0.0\nid",
		"1.0.0\x00",
		"'",
		"1.0.0 && curl evil",
	]) {
		assert.equal(isValidVersionRange(bad), false, `should reject ${JSON.stringify(bad)}`);
	}
});

test("isValidVersionRange rejects empty, overlong, non-strings", () => {
	assert.equal(isValidVersionRange(""), false);
	assert.equal(isValidVersionRange("1".repeat(101)), false);
	assert.equal(isValidVersionRange(undefined), false);
	assert.equal(isValidVersionRange(null), false);
	assert.equal(isValidVersionRange({}), false);
});
