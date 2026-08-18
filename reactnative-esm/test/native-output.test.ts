// Native output invariants that only show up at runtime on a device, pinned
// here so they can't regress silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBuildPaths } from "../src/output";

// Suggested by the orchd cutover session after their verification nearly
// produced a false alarm: grepping for the helper NAMES (__publicField /
// __defNormalProp) proves nothing, because healthy bundles contain hundreds of
// them. What matters is the helper's BODY -- spec [[Define]] semantics vs
// Metro's loose assignment. RN's VirtualizedList installs `state` as a
// getter/setter without configurable:true, so a later [[Define]] throws
// "property is not configurable" where [[Set]] succeeds.
const SPEC_HELPER =
	'var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;';
const LOOSE_HELPER = "var __defNormalProp = (obj, key, value) => (obj[key] = value);";

// Re-implemented here rather than exported, to assert on the exact anchor the
// server rewrite depends on.
const ESBUILD_DEFNORMALPROP_RE =
	/var __defNormalProp = \(obj, key, value\) => key in obj \? __defProp\(obj, key, \{[^}]*\}\) : obj\[key\] = value;/;

test("the spec-semantics helper esbuild emits is still recognised by the rewrite anchor", () => {
	assert.match(SPEC_HELPER, ESBUILD_DEFNORMALPROP_RE);
});

test("the loose helper is NOT matched (no double-rewrite, and it is the desired end state)", () => {
	assert.doesNotMatch(LOOSE_HELPER, ESBUILD_DEFNORMALPROP_RE);
});

test("helper names alone are not a health signal", () => {
	// A bundle can be full of __publicField calls and still be correct -- the
	// call sites are fine, only the helper body matters. Documented so nobody
	// re-derives this during an incident.
	const healthy = `${LOOSE_HELPER}\n__publicField(this, "state");\n__publicField(this, "_x", 1);`;
	assert.equal(healthy.includes("__publicField"), true);
	assert.doesNotMatch(healthy, ESBUILD_DEFNORMALPROP_RE, "healthy despite the helper names being present");
});

test("normalizeBuildPaths removes the per-request build root", () => {
	const tmp = "/private/var/folders/62/abc/T/bundle-deps-Q4Z5ZQ";
	const code =
		"// ../../../../private/var/folders/62/abc/T/bundle-deps-Q4Z5ZQ/node_modules/react-native/index.js\nvar a = 1;";
	const out = normalizeBuildPaths(code, tmp);
	assert.equal(out.includes("bundle-deps-Q4Z5ZQ"), false, "random dir name gone");
	assert.equal(out.includes("var/folders"), false, "server path gone");
	assert.match(out, /__pkgroot__\/node_modules\/react-native\/index\.js/);
});

test("normalizeBuildPaths makes two builds of the same code byte-identical", () => {
	// This is what lets chunks be content-addressed and reused across
	// dependency sets; without it every build differs by its mkdtemp name.
	const mk = (dir: string) =>
		normalizeBuildPaths(`// ../../../tmp/${dir}/node_modules/x/index.js\nvar a = 1;`, `/tmp/${dir}`);
	assert.equal(mk("bundle-deps-AAAAAA"), mk("bundle-deps-ZZZZZZ"));
});
