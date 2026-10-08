// Metro parity for package.json "react-native"/"browser" object maps on
// native. Locks in the fix for @base44/sdk shipping as `module.exports = {}`
// under rnrun: socket.io-client's engine.io-client swaps its Node transport
// for the browser one through these maps, which esbuild ignored on native.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { esbuildPlatformSettings, type BuildPlatform } from "../src/platform";
import { makePackageMapsPlugin } from "../src/package-maps";

function fixture(files: Record<string, string | object>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-maps-"));
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
	}
	return dir;
}

async function bundle(dir: string, platform: BuildPlatform, withPlugin = true): Promise<string> {
	const result = await esbuild.build({
		entryPoints: [path.join(dir, "entry.js")],
		bundle: true,
		write: false,
		format: "iife",
		...esbuildPlatformSettings(platform),
		plugins: withPlugin ? [makePackageMapsPlugin(platform)] : [],
		logLevel: "silent",
	});
	return result.outputFiles[0].text;
}

function run(code: string): any {
	const g = globalThis as any;
	delete g.__out;
	new Function(code)();
	return g.__out;
}

// engine.io-client's real layout: exports into build/esm, and a package.json
// per build directory carrying the browser map, relative to that directory.
const engineIoShape = {
	"entry.js": `import { WS } from "eio";\nglobalThis.__out = WS;\n`,
	"node_modules/eio/package.json": {
		name: "eio",
		exports: { ".": { import: "./build/esm/index.js", require: "./build/cjs/index.js" } },
		browser: { "./build/esm/transports/websocket.node.js": "./build/esm/transports/websocket.js" },
	},
	"node_modules/eio/build/esm/package.json": {
		name: "eio",
		type: "module",
		browser: { ws: false, "./transports/websocket.node.js": "./transports/websocket.js" },
	},
	"node_modules/eio/build/esm/index.js": `export { WS } from "./transports/index.js";\n`,
	"node_modules/eio/build/esm/transports/index.js": `export { WS } from "./websocket.node.js";\n`,
	"node_modules/eio/build/esm/transports/websocket.node.js": `import * as ws from "ws";\nexport const WS = "node:" + typeof ws.WebSocket;\n`,
	"node_modules/eio/build/esm/transports/websocket.js": `export const WS = "browser";\n`,
	"node_modules/ws/package.json": { name: "ws", main: "index.js" },
	"node_modules/ws/index.js": `require("zlib");\nmodule.exports = { WebSocket: function () {} };\n`,
};

test("without the maps, native pulls the Node transport and fails on its builtins (the bug)", async () => {
	const dir = fixture(engineIoShape);
	await assert.rejects(bundle(dir, "ios", false), /Could not resolve "zlib"/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("the closest package.json's map swaps a relative import for the browser transport", async () => {
	const dir = fixture(engineIoShape);
	for (const platform of ["ios", "android"] as const) {
		const code = await bundle(dir, platform);
		assert.equal(run(code), "browser");
		assert.doesNotMatch(code, /zlib/, "the Node `ws` package never enters the bundle");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a bare specifier mapped to false is one shared empty module", async () => {
	const dir = fixture({
		"entry.js": `globalThis.__out = require("a");\n`,
		"node_modules/a/package.json": { name: "a", main: "index.js", browser: { fs: false, "os.js": false } },
		"node_modules/a/index.js": `module.exports = [require("fs"), require("os")];\n`,
	});
	const [fsModule, osModule] = run(await bundle(dir, "ios"));
	assert.deepEqual(fsModule, {});
	assert.equal(fsModule, osModule, "Metro resolves every false to its single emptyModulePath");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a package without exports has its entry point and subpaths redirected", async () => {
	const dir = fixture({
		"entry.js": `globalThis.__out = [require("pc"), require("deep/lib/node")];\n`,
		"node_modules/pc/package.json": { name: "pc", main: "./picocolors.js", browser: { "./picocolors.js": "./picocolors.browser.js" } },
		"node_modules/pc/picocolors.js": `module.exports = "node";\n`,
		"node_modules/pc/picocolors.browser.js": `module.exports = "browser";\n`,
		"node_modules/deep/package.json": { name: "deep", main: "index.js", browser: { "./lib/node.js": "./lib/browser.js" } },
		"node_modules/deep/lib/node.js": `module.exports = "node";\n`,
		"node_modules/deep/lib/browser.js": `module.exports = "browser";\n`,
	});
	assert.deepEqual(run(await bundle(dir, "ios")), ["browser", "browser"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("an exports target is used as resolved, as Metro does", async () => {
	const dir = fixture({
		"entry.js": `globalThis.__out = require("ex");\n`,
		"node_modules/ex/package.json": { name: "ex", exports: { ".": "./node.js" }, main: "./node.js", browser: { "./node.js": "./browser.js" } },
		"node_modules/ex/node.js": `module.exports = "node";\n`,
		"node_modules/ex/browser.js": `module.exports = "browser";\n`,
	});
	assert.equal(run(await bundle(dir, "ios")), "node");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("react-native wins over browser, and keys match with .js appended", async () => {
	const dir = fixture({
		"entry.js": `globalThis.__out = require("both");\n`,
		"node_modules/both/package.json": {
			name: "both",
			main: "index.js",
			"react-native": { "./impl.js": "./impl.rn.js" },
			browser: { "./impl.js": "./impl.browser.js" },
		},
		"node_modules/both/index.js": `module.exports = require("./impl");\n`,
		"node_modules/both/impl.js": `module.exports = "node";\n`,
		"node_modules/both/impl.rn.js": `module.exports = "react-native";\n`,
		"node_modules/both/impl.browser.js": `module.exports = "browser";\n`,
	});
	assert.equal(run(await bundle(dir, "android")), "react-native");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a bare specifier can be replaced by another package", async () => {
	const dir = fixture({
		"entry.js": `globalThis.__out = require("uses-vm");\n`,
		"node_modules/uses-vm/package.json": { name: "uses-vm", main: "index.js", browser: { vm: "vm-shim" } },
		"node_modules/uses-vm/index.js": `module.exports = require("vm").name;\n`,
		"node_modules/vm-shim/package.json": { name: "vm-shim", main: "index.js" },
		"node_modules/vm-shim/index.js": `module.exports = { name: "shim" };\n`,
	});
	assert.equal(run(await bundle(dir, "ios")), "shim");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("web output is byte-identical with the plugin registered", async () => {
	const dir = fixture(engineIoShape);
	assert.equal(await bundle(dir, "web", true), await bundle(dir, "web", false));
	fs.rmSync(dir, { recursive: true, force: true });
});
