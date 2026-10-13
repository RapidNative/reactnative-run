// A package that requires a helper runtime it doesn't declare must still bundle. Observed:
// @react-native-community/slider 5.2.0 requires @babel/runtime helpers with no dependencies at all,
// and every web build of it failed on /pkg ("Could not resolve "@babel/runtime/helpers/...").

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import esbuild from "esbuild";
import { helperRuntimesToInstall } from "../src/helper-runtimes";

const unresolved = (spec: string) => ({ text: `Could not resolve "${spec}"` });
const nothingInstalled = () => false;

test("the slider's failure installs @babel/runtime once, on the 7 line", () => {
	const errors = [
		unresolved("@babel/runtime/helpers/interopRequireDefault"),
		unresolved("@babel/runtime/helpers/toConsumableArray"),
		unresolved("@babel/runtime/helpers/slicedToArray"),
		unresolved("@babel/runtime/helpers/objectWithoutProperties"),
		unresolved("@babel/runtime/helpers/interopRequireDefault"),
	];
	assert.deepEqual(helperRuntimesToInstall(errors, nothingInstalled), ["@babel/runtime@^7"]);
});

test("each missing runtime is installed, bare or by subpath", () => {
	const errors = [unresolved("tslib"), unresolved("@babel/runtime/regenerator"), unresolved("regenerator-runtime/runtime")];
	assert.deepEqual(helperRuntimesToInstall(errors, nothingInstalled), [
		"tslib@^2",
		"@babel/runtime@^7",
		"regenerator-runtime@^0.14",
	]);
});

test("nothing is installed when the build would still fail", () => {
	// Another unresolved package: installing the runtime leaves that error in place.
	assert.deepEqual(
		helperRuntimesToInstall(
			[unresolved("@babel/runtime/helpers/interopRequireDefault"), unresolved("left-pad")],
			nothingInstalled
		),
		[]
	);
	// An error of another kind.
	assert.deepEqual(
		helperRuntimesToInstall(
			[unresolved("@babel/runtime/helpers/interopRequireDefault"), { text: 'Expected ";" but found "x"' }],
			nothingInstalled
		),
		[]
	);
	assert.deepEqual(helperRuntimesToInstall([], nothingInstalled), []);
});

test("an installed runtime that lacks a helper isn't installed again", () => {
	// The package declares an older @babel/runtime than its helpers need. A second install of the
	// same package can't add the helper, and must not loop.
	const installed = (pkg: string) => pkg === "@babel/runtime";
	assert.deepEqual(helperRuntimesToInstall([unresolved("@babel/runtime/helpers/newHelper")], installed), []);
});

test("the anchor matches what the installed esbuild reports", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helper-runtimes-"));
	try {
		const entry = path.join(dir, "index.js");
		fs.writeFileSync(entry, 'module.exports = require("@babel/runtime/helpers/interopRequireDefault");\n');
		const failure = await esbuild
			.build({ entryPoints: [entry], bundle: true, write: false, logLevel: "silent", platform: "browser" })
			.then(
				() => null,
				(err: esbuild.BuildFailure) => err
			);
		assert.ok(failure, "the build must fail with the runtime missing");
		assert.deepEqual(helperRuntimesToInstall(failure.errors, nothingInstalled), ["@babel/runtime@^7"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
