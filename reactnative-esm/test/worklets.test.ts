import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	shouldWorkletize,
	parserAndLoaderFor,
	workletsRuntimeVersion,
	mayWorkletize,
	pinBabelForPlugin,
	babelPinned,
	WORKLET_FILE_RE,
} from "../src/worklets";

const nm = (p: string) => path.join("/tmp/build", "node_modules", p);

test("file gate covers every package, not just reanimated", () => {
	for (const p of [
		"react-native-keyboard-controller/lib/module/animated.js",
		"@gorhom/bottom-sheet/lib/module/components/bottomSheet/BottomSheet.js",
		"react-native-reanimated/src/hook/useAnimatedStyle.ts",
		"some-pkg/dist/index.mjs",
		"some-pkg/src/Thing.tsx",
	]) {
		assert.ok(WORKLET_FILE_RE.test(nm(p)), p);
	}
	assert.ok(!WORKLET_FILE_RE.test(nm("some-pkg/readme.md")));
	assert.ok(!WORKLET_FILE_RE.test("/src/app/_layout.tsx"), "user code is rnrun's job");
});

test("content gate: explicit 'worklet' directive", () => {
	// The exact shape that red-screened: react-native-keyboard-controller's
	// KeyboardProvider handlers.
	const src = `
		const keyboardHandler = useAnimatedKeyboardHandler({
			onKeyboardMoveStart: event => {
				"worklet";
				updateSharedValues(event, ["ios"]);
			},
		}, []);`;
	assert.ok(shouldWorkletize(nm("react-native-keyboard-controller/lib/module/animated.js"), src));
});

test("content gate: auto-workletized callbacks with no directive", () => {
	// @gorhom/bottom-sheet relies entirely on the plugin auto-workletizing the
	// callback -- a directive-only gate ships this broken.
	const src = `const s = useAnimatedStyle(() => ({ opacity: v.value }));`;
	assert.ok(shouldWorkletize(nm("@gorhom/bottom-sheet/lib/module/x.js"), src));
	assert.ok(shouldWorkletize(nm("p/x.js"), `withTiming(1, { duration: 200 })`));
	assert.ok(shouldWorkletize(nm("p/x.js"), `Gesture.Pan().onUpdate(e => {})`));
});

test("content gate skips files with nothing worklet-shaped", () => {
	assert.ok(!shouldWorkletize(nm("lodash/index.js"), `module.exports = function (a) { return a; };`));
});

test("content gate skips react-native core and pre-compiled worklets", () => {
	assert.ok(
		!shouldWorkletize(nm("react-native/Libraries/Animated/x.js"), `useAnimatedStyle(() => ({}))`),
		"RN core is claimed by strip-flow's full preset"
	);
	assert.ok(
		!shouldWorkletize(nm("p/x.js"), `const f = function () { "worklet"; }; f.__workletHash = 123;`),
		"already plugin output -- transforming again re-wraps a live worklet"
	);
	assert.ok(
		!shouldWorkletize(nm("p/x.js"), `f.__pluginVersion = "0.10.1"; f.__workletHash = 7;`),
		"the plugin's own version stamp is the other output marker"
	);
});

test("reading __workletHash is not the same as being plugin output", () => {
	// react-native-worklets' own valueUnpacker.native.ts. A guard that matched
	// any mention of __workletHash skipped this file, the generated unpacker
	// never existed, and installUnpackers threw "Cannot read property 'code' of
	// undefined" before the first screen rendered.
	const valueUnpacker = `
		export function installValueUnpacker() {
			'worklet';
			function valueUnpacker(objectToUnpack) {
				const workletHash = objectToUnpack.__workletHash;
				if (workletHash !== undefined) {
					const initData = objectToUnpack.__initData;
				}
			}
		}`;
	assert.ok(
		shouldWorkletize(nm("react-native-worklets/src/memory/valueUnpacker.native.ts"), valueUnpacker),
		"this file DEFINES a worklet, it is not the output of one"
	);
	// reanimated's core hooks read the property the same way.
	assert.ok(
		shouldWorkletize(
			nm("react-native-reanimated/src/hook/useAnimatedStyle.ts"),
			`export function useAnimatedStyle(updater) { if (updater.__workletHash !== last) {} }`
		)
	);
	assert.ok(
		shouldWorkletize(nm("p/x.ts"), `runOnUI(f); const h = fn.__workletHash === other.__workletHash;`),
		"a comparison is not an assignment"
	);
});

test("loader matches the real extension", () => {
	assert.deepEqual(parserAndLoaderFor(nm("p/x.ts")), { parserPlugins: ["typescript"], loader: "ts" });
	assert.deepEqual(parserAndLoaderFor(nm("p/x.tsx")), { parserPlugins: ["typescript", "jsx"], loader: "tsx" });
	assert.deepEqual(parserAndLoaderFor(nm("p/x.js")), { parserPlugins: ["flow", "jsx"], loader: "jsx" });
	assert.deepEqual(parserAndLoaderFor(nm("p/x.cjs")), { parserPlugins: ["flow", "jsx"], loader: "jsx" });
});

test("chunk keys only move for packages that can carry worklets", () => {
	assert.ok(mayWorkletize("react-native-worklets", []));
	assert.ok(mayWorkletize("react-native-reanimated", []));
	assert.ok(mayWorkletize("react-native-keyboard-controller", ["react", "react-native", "react-native-reanimated"]));
	assert.ok(!mayWorkletize("react-native-svg", ["react", "react-native"]));
	assert.ok(!mayWorkletize("lodash", []));
});

test("worklets runtime version is read from the build root", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "worklets-test-"));
	try {
		assert.equal(workletsRuntimeVersion(root), null, "no reanimated installed -> the pass is inert");

		const ra = path.join(root, "node_modules", "react-native-reanimated");
		fs.mkdirSync(ra, { recursive: true });
		fs.writeFileSync(path.join(ra, "package.json"), JSON.stringify({ name: "react-native-reanimated", version: "3.16.0" }));
		assert.equal(workletsRuntimeVersion(root), "reanimated-3.16.0", "reanimated 3 has the plugin in-tree");

		const w = path.join(root, "node_modules", "react-native-worklets");
		fs.mkdirSync(w, { recursive: true });
		fs.writeFileSync(path.join(w, "package.json"), JSON.stringify({ name: "react-native-worklets", version: "0.10.1" }));
		assert.equal(workletsRuntimeVersion(root), "0.10.1", "reanimated 4 splits worklets out; it wins");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ── @babel/* pinning ────────────────────────────────────────────────────────
// The bug this guards: `bun install` hoists a babel 8 SUBSET into the build
// root (core, generator, parser, template, helpers, code-frame) while the
// worklets plugin's own deps stay on 7. The plugin then throws per file and
// the chunk ships unworkletized -- silently, until it crashes on device.

/** A build root shaped like the one bun produces. */
function fakeRoot(hoisted: Record<string, string>): { root: string; plugin: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "worklets-pin-"));
	for (const [name, version] of Object.entries(hoisted)) {
		const dir = path.join(root, "node_modules", "@babel", name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@babel/${name}`, version }));
	}
	const pkg = path.join(root, "node_modules", "react-native-worklets");
	fs.mkdirSync(path.join(pkg, "plugin"), { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "package.json"),
		JSON.stringify({ name: "react-native-worklets", version: "0.10.1", dependencies: { "@babel/preset-typescript": "^7.28.5" } })
	);
	const plugin = path.join(pkg, "plugin", "index.js");
	fs.writeFileSync(plugin, "module.exports = {};\n");
	return { root, plugin };
}

const linkedNames = (root: string): string[] => {
	const dir = path.join(root, "node_modules", "react-native-worklets", "node_modules", "@babel");
	try {
		return fs.readdirSync(dir).sort();
	} catch {
		return [];
	}
};

test("pins the hoisted babel packages that disagree with the plugin", () => {
	const { root, plugin } = fakeRoot({
		core: "8.0.6",
		generator: "8.0.6",
		parser: "8.0.6",
		types: "7.29.7",
		traverse: "7.29.7",
	});
	try {
		babelPinned.clear();
		pinBabelForPlugin(plugin, root);
		assert.deepEqual(linkedNames(root), ["core", "generator", "parser"], "only the mismatched majors");
		for (const name of linkedNames(root)) {
			const link = path.join(root, "node_modules", "react-native-worklets", "node_modules", "@babel", name);
			assert.ok(fs.lstatSync(link).isSymbolicLink());
			const version = JSON.parse(fs.readFileSync(path.join(link, "package.json"), "utf8")).version;
			assert.equal(version.split(".")[0], "7", `${name} now resolves to babel 7`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("pins nothing when the build root already agrees", () => {
	const { root, plugin } = fakeRoot({ core: "7.29.7", generator: "7.29.7" });
	try {
		babelPinned.clear();
		pinBabelForPlugin(plugin, root);
		assert.deepEqual(linkedNames(root), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("leaves independently-versioned @babel/* packages alone", () => {
	// @babel/helper-define-polyfill-provider is on 0.x and is NOT part of the
	// monorepo's version line -- reporting it as a mismatch is noise.
	const { root, plugin } = fakeRoot({ "helper-define-polyfill-provider": "0.6.5" });
	try {
		babelPinned.clear();
		pinBabelForPlugin(plugin, root);
		assert.deepEqual(linkedNames(root), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
