// Metro parity for ".fx" side-effect modules: importing one must not evaluate
// it at bundle init; only using a binding does. Locks in the fix for
// expo-notifications red-screening Android Expo Go under rnrun (its .fx module
// throws at import there; under Metro it is never evaluated).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { hasFxImport, rewriteFxImports } from "../src/lazy-fx";

test("re-exports from a .fx module become lazy function wrappers", async () => {
	const src = `export { setAutoServerRegistrationEnabledAsync } from './DevicePushTokenAutoRegistration.fx';\nexport { a as b, default as d } from "./other.fx.js";\nexport { keep } from './not-fx';\n`;
	assert.equal(hasFxImport(src), true);
	const out = await rewriteFxImports(src, "/x/node_modules/pkg/index.js");
	assert.match(out, /export function setAutoServerRegistrationEnabledAsync\(\.\.\.args\) \{\s*return require\("\.\/DevicePushTokenAutoRegistration\.fx"\)\.setAutoServerRegistrationEnabledAsync\(\.\.\.args\);\s*\}/);
	assert.match(out, /export function b\(\.\.\.args\) \{\s*return require\("\.\/other\.fx\.js"\)\.a\(\.\.\.args\);\s*\}/);
	assert.match(out, /export function d\(\.\.\.args\) \{\s*return require\("\.\/other\.fx\.js"\)\.default\(\.\.\.args\);\s*\}/);
	assert.match(out, /export \{ keep \} from '\.\/not-fx';/, "non-.fx re-exports untouched");
});

test("named imports from a .fx module are deferred to their use sites", async () => {
	const src = `import { setAutoServerRegistrationEnabledAsync as enable, other } from './Reg.fx';\nimport * as ns from './All.fx';\nimport keep from './keep';\nexport async function go(v) { await enable(v); return other + ns.thing + keep; }\n`;
	const out = await rewriteFxImports(src, "/x/node_modules/pkg/go.js");
	assert.doesNotMatch(out, /import \{[^}]*\} from '\.\/Reg\.fx'/, "static import removed");
	assert.doesNotMatch(out, /import \* as ns/);
	assert.match(out, /await require\("\.\/Reg\.fx"\)\.setAutoServerRegistrationEnabledAsync\(v\)/);
	assert.match(out, /require\("\.\/Reg\.fx"\)\.other \+ require\("\.\/All\.fx"\)\.thing \+ keep/);
	assert.match(out, /import keep from '\.\/keep';/, "other imports untouched");
});

test("bare side-effect imports of a .fx module stay eager (Metro parity)", async () => {
	const src = "import './Expo.fx';\nexport const x = 1;\n";
	assert.equal(hasFxImport(src), false);
	const out = await rewriteFxImports(src, "/x/node_modules/expo/build/Expo.js");
	assert.equal(out, src);
});

test("a binding referenced where an expression cannot go leaves the file untouched", async () => {
	const src = "import { a } from './x.fx';\nexport { a };\n";
	const out = await rewriteFxImports(src, "/x/node_modules/pkg/i.js");
	assert.equal(out, src);
});

test("bundled: the .fx module is not evaluated at init through either path, only on use", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-fx-"));
	const pkg = path.join(dir, "node_modules", "pkg");
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "thing.fx.js"),
		"globalThis.__fxRan = (globalThis.__fxRan || 0) + 1;\nif (globalThis.__fxThrow) throw new Error('boom at import');\nexport function enable(v) { return 'enabled:' + v; }\n",
	);
	// The expo-notifications shape: index re-exports from the .fx file AND
	// re-exports another module that imports the .fx file for its own use.
	fs.writeFileSync(path.join(pkg, "token.js"), "import { enable } from './thing.fx';\nexport function getToken(v) { return 'token:' + enable(v); }\n");
	fs.writeFileSync(path.join(pkg, "index.js"), "export const plain = 1;\nexport { enable } from './thing.fx';\nexport { getToken } from './token';\n");
	fs.writeFileSync(path.join(dir, "entry.js"), "import { plain, enable, getToken } from 'pkg';\nglobalThis.__plain = plain;\nglobalThis.__enable = enable;\nglobalThis.__getToken = getToken;\n");

	const plugin: esbuild.Plugin = {
		name: "lazy-fx-test",
		setup(build) {
			build.onLoad({ filter: /\.[cm]?jsx?$/ }, async (args) => {
				if (!/node_modules[/\\]/.test(args.path)) return undefined;
				const src = await fs.promises.readFile(args.path, "utf8");
				if (!hasFxImport(src)) return undefined;
				const out = await rewriteFxImports(src, args.path);
				return out === src ? undefined : { contents: out, loader: "jsx" };
			});
		},
	};
	const result = await esbuild.build({
		entryPoints: [path.join(dir, "entry.js")],
		bundle: true,
		write: false,
		format: "iife",
		platform: "neutral",
		mainFields: ["main"],
		plugins: [plugin],
		logLevel: "silent",
	});
	const code = result.outputFiles[0].text;

	const g = globalThis as any;
	g.__fxRan = 0;
	g.__fxThrow = true; // how Expo Go on Android behaves for expo-notifications
	new Function(code)(); // must NOT throw
	assert.equal(g.__plain, 1);
	assert.equal(g.__fxRan, 0, ".fx module untouched at init");

	g.__fxThrow = false;
	assert.equal(g.__getToken("x"), "token:enabled:x", "use through the importing module works");
	assert.equal(g.__enable("y"), "enabled:y", "use through the re-export works");
	assert.equal(g.__fxRan, 1, "evaluated exactly once, on first use");
	fs.rmSync(dir, { recursive: true, force: true });
});
