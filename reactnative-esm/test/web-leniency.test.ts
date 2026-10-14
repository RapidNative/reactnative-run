// @firebase/database imports @firebase/app but declares it only as a devDependency, so the web
// build failed with `Could not resolve "@firebase/app"` (HTTP 500). Web now externalizes an import
// only when esbuild itself cannot resolve it, so every build that works today keeps its bytes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import esbuild from "esbuild";
import { unresolvableOnWeb } from "../src/web-leniency";

function fixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-leniency-"));
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), body);
	};
	write("node_modules/present/package.json", JSON.stringify({ name: "present", main: "index.js" }));
	write("node_modules/present/index.js", "module.exports = 'present';\n");
	// Only a browser build can resolve this one: Node's require.resolve would not.
	write("node_modules/browser-only/package.json", JSON.stringify({ name: "browser-only", exports: { browser: "./web.js" } }));
	write("node_modules/browser-only/web.js", "module.exports = 'browser-only';\n");
	write("node_modules/pkg/package.json", JSON.stringify({ name: "pkg", main: "index.js" }));
	write(
		"node_modules/pkg/index.js",
		"module.exports = [require('present'), require('browser-only'), require('@firebase/app')];\n",
	);
	write("entry.js", "module.exports = require('pkg');\n");
	return dir;
}

async function build(dir: string, lenient: boolean) {
	const plugin: esbuild.Plugin = {
		name: "test-external",
		setup(b) {
			b.onResolve({ filter: /^[^./]/ }, async (args) => {
				if (lenient && (await unresolvableOnWeb(b, args))) return { path: args.path, external: true };
				return null;
			});
		},
	};
	return esbuild.build({
		entryPoints: [path.join(dir, "entry.js")],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "browser",
		logLevel: "silent",
		plugins: [plugin],
	});
}

test("an import nothing can resolve is left external instead of failing the build", async () => {
	const dir = fixture();
	try {
		await assert.rejects(build(dir, false), /Could not resolve "@firebase\/app"/);
		const out = (await build(dir, true)).outputFiles[0].text;
		assert.match(out, /require\("@firebase\/app"\)/);
		// Resolvable imports are still inlined.
		assert.match(out, /'present'|"present"/);
		assert.match(out, /'browser-only'|"browser-only"/);
		assert.doesNotMatch(out, /require\("present"\)|require\("browser-only"\)/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a build that already works produces identical bytes", async () => {
	const dir = fixture();
	try {
		fs.writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "module.exports = [require('present'), require('browser-only')];\n");
		const before = (await build(dir, false)).outputFiles[0].text;
		const after = (await build(dir, true)).outputFiles[0].text;
		assert.equal(after, before);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
