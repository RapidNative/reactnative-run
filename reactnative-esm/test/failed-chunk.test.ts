// A dependency the server could not build ships as an empty module. On native it now names the
// cause when the app requires it (an empty @base44/sdk crashed far from its cause); web keeps its
// exact old bytes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { failedChunk } from "../src/failed-chunk";

const ESBUILD_ERROR =
	'Build failed with 24 errors:\n../../../tmp/bundle-deps-c9Rg2D/node_modules/engine.io-client/node_modules/ws/lib/permessage-deflate.js:3:21: ERROR: Could not resolve "zlib"';

/** Evaluate a chunk body the way a module factory would, capturing console.error. */
function run(chunk: string): { exports: unknown; errors: string[] } {
	const errors: string[] = [];
	const module = { exports: {} as unknown };
	new Function("module", "console", chunk)(module, { error: (m: string) => errors.push(m) });
	return { exports: module.exports, errors };
}

test("web keeps the old stub bytes exactly", () => {
	const safe = ESBUILD_ERROR.replace(/[\r\n\t]+/g, " ").slice(0, 200);
	assert.equal(
		failedChunk("@base44/sdk", "web", ESBUILD_ERROR),
		`// @dep-start @base44/sdk\n// Error bundling: ${safe}\nmodule.exports = {};\n// @dep-end @base44/sdk`
	);
	assert.equal(
		failedChunk("left-pad", "web", "install spec unsatisfiable", "Dropped"),
		"// @dep-start left-pad\n// Dropped: install spec unsatisfiable\nmodule.exports = {};\n// @dep-end left-pad"
	);
	assert.deepEqual(run(failedChunk("@base44/sdk", "web", ESBUILD_ERROR)).errors, []);
});

test("native names the package and the cause when the chunk is evaluated, and stays empty", () => {
	for (const platform of ["ios", "android"] as const) {
		const { exports, errors } = run(failedChunk("@base44/sdk", platform, ESBUILD_ERROR));
		assert.deepEqual(exports, {});
		assert.equal(errors.length, 1);
		assert.match(errors[0], new RegExp(`^\\[package server\\] @base44/sdk could not be built for ${platform}`));
		assert.match(errors[0], /Could not resolve "zlib"/);
		assert.match(errors[0], /: engine\.io-client\/node_modules\/ws\/lib\/permessage-deflate\.js:3:21/, "temp-dir prefix trimmed, chain kept");
		assert.doesNotMatch(errors[0], /tmp\/bundle-deps/);
	}
});

test("a message with quotes, backslashes, comment closers or line separators stays one valid chunk", () => {
	const nasty = 'a "quote" \\ back */ end next line\r\nmore';
	const { exports, errors } = run(failedChunk("weird-pkg", "ios", nasty));
	assert.deepEqual(exports, {});
	assert.equal(errors.length, 1);
	assert.match(errors[0], /a "quote" \\ back \*\/ end next line more$/);
});

test("the chunk keeps its dep-start/dep-end frame", () => {
	const chunk = failedChunk("expo-router/drawer", "android", "boom");
	assert.match(chunk, /^\/\/ @dep-start expo-router\/drawer\n/);
	assert.match(chunk, /\n\/\/ @dep-end expo-router\/drawer$/);
});
