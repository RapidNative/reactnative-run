import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bunLockMeta, failureCache, nodeModulesMeta, workletsRuntimeVersionFrom, SERVER_CODE_ID } from "../src/dep-meta";

// A text bun.lock as bun writes it: JSON with trailing commas.
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "t", "dependencies": { "a": "1.0.0", }, }, },
  "packages": {
    "a": ["a@1.0.0", "", { "dependencies": { "b": "^2.0.0", "shared": "*" }, "peerDependencies": { "shared": "*", "react": "*" }, "optionalPeers": ["react"] }, "sha512-x"],
    "@scope/b": ["@scope/b@2.1.0", "", {}, "sha512-y"],
    "a/nested": ["nested@9.9.9", "", {}, "sha512-z"],
    "native-other-arch": ["native-other-arch@1.0.0", "", { "os": "${process.platform === "darwin" ? "linux" : "darwin"}", "cpu": "arm64" }, "sha512-w"],
    "native-here": ["native-here@1.0.0", "", { "os": "${process.platform}" }, "sha512-v"],
    "react-native-worklets": ["react-native-worklets@0.13.1", "", {}, "sha512-u"],
  },
}
`;

test("bun.lock: hoisted entries read like their package.json", () => {
	const meta = bunLockMeta(LOCK);
	const a = meta("a")!;
	assert.strictEqual(a.version, "1.0.0");
	// The server only ever uses the union, which is what bun's dedup preserves.
	assert.deepStrictEqual(Object.keys({ ...a.dependencies, ...a.peerDependencies }).sort(), ["b", "react", "shared"]);
	assert.strictEqual(meta("@scope/b")!.version, "2.1.0");
	assert.strictEqual(meta("missing"), null);
});

test("bun.lock: nested copies and subpaths are not hoisted packages", () => {
	const meta = bunLockMeta(LOCK);
	assert.strictEqual(meta("a/nested"), null);
	assert.strictEqual(meta("@scope/b/sub"), null);
});

test("bun.lock: packages for another os/cpu are not installed, so they are absent", () => {
	const meta = bunLockMeta(LOCK);
	assert.strictEqual(meta("native-other-arch"), null);
	assert.ok(meta("native-here"));
});

test("worklets runtime version from metadata", () => {
	assert.strictEqual(workletsRuntimeVersionFrom(bunLockMeta(LOCK)), "0.13.1");
	const reanimatedOnly = bunLockMeta(`{"packages":{"react-native-reanimated":["react-native-reanimated@3.17.0","",{},""],}}`);
	assert.strictEqual(workletsRuntimeVersionFrom(reanimatedOnly), "reanimated-3.17.0");
	assert.strictEqual(workletsRuntimeVersionFrom(bunLockMeta(`{"packages":{}}`)), null);
});

test("node_modules metadata reads installed package.json files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dep-meta-"));
	const dir = path.join(root, "node_modules", "@s", "p");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "3.0.0", peerDependencies: { react: "*" }, keywords: ["react-native"] }));
	const meta = nodeModulesMeta(root);
	assert.deepStrictEqual(meta("@s/p"), { version: "3.0.0", dependencies: {}, peerDependencies: { react: "*" }, keywords: ["react-native"] });
	assert.strictEqual(meta("nope"), null);
	fs.rmSync(root, { recursive: true, force: true });
});

test("failure cache records only resolution failures, under this code's id", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-fail-"));
	const cache = failureCache(dir, true);
	cache.write("k1", "stub-1", 'Build failed: Could not resolve "node:fs"');
	cache.write("k2", "stub-2", "esbuild service was stopped");
	assert.strictEqual(cache.read("k1"), "stub-1");
	assert.strictEqual(cache.read("k2"), null, "transient failures are rebuilt");
	assert.ok(fs.existsSync(path.join(dir, `k1.failed-${SERVER_CODE_ID}.js`)));
	assert.strictEqual(failureCache(dir, false).read("k1"), null, "disabled with the chunk cache");
	fs.rmSync(dir, { recursive: true, force: true });
});
