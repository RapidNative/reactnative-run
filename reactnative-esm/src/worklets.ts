// react-native-worklets/plugin over npm PACKAGE sources (native only).
//
// Reanimated splits a worklet into a factory the UI runtime can evaluate plus a
// `__workletHash` the runtime checks. Nothing in esbuild does that -- only
// react-native-worklets/plugin does, and Metro runs it over EVERY file via the
// project's babel.config.js. rnrun runs it over user code
// (cli/src/bundler/worklets.ts); npm packages come pre-bundled from here, so
// this is the only place they can get it.
//
// The gate used to be "files inside react-native-reanimated or
// react-native-worklets". That is not where most worklets live: any package
// that animates ships them too, and each one crashed at runtime under rnrun
// while working under Metro. react-native-keyboard-controller was the report
// ("Passed handlers that are not worklets ... onKeyboardMoveStart, ..." from
// KeyboardProvider), @gorhom/bottom-sheet the same class of bug. So the gate is
// now the package tree, narrowed by content.

import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import semver from "semver";
import type esbuild from "esbuild";
import type { BuildPlatform } from "./platform";
import { RN_CORE_RE } from "./codegen";

const execFileAsync = promisify(execFile);

/** Content gate: files that can contain worklets.
 *
 *  Deliberately WIDER than a `'worklet'` directive search, and kept in sync
 *  with rnrun's gate for user code (cli/src/bundler/worklets.ts). The plugin
 *  auto-workletizes the callback passed to a known reanimated API, so a package
 *  that calls `useAnimatedStyle(() => ({...}))` with no directive anywhere
 *  depends on this pass exactly as much as one that writes the directive --
 *  and a directive-only gate ships it broken. */
export const WORKLET_HINT_RE =
	/['"]worklet['"]|useAnimatedStyle|useAnimatedProps|useDerivedValue|useAnimatedScrollHandler|useAnimatedReaction|useFrameCallback|useAnimatedGestureHandler|createAnimatedPropAdapter|withTiming|withSpring|withDecay|withClamp|runOnUI|runOnRuntime|useAnimatedKeyboard|useScrollViewOffset|Gesture\./;

/** Already-compiled worklets: some packages ship plugin OUTPUT (the factory,
 *  its `__workletHash` and a `__pluginVersion` stamp are already in the
 *  published file). Running the plugin over that re-wraps a function that is
 *  already a worklet, so skip it.
 *
 *  This must match an ASSIGNMENT of a literal, never a reference. A plain
 *  `/__workletHash/` also matches source that merely READS the property --
 *  react-native-worklets' own valueUnpacker.native.ts, and reanimated's
 *  useAnimatedStyle / useHandler / useDerivedValue / useAnimatedReaction. Those
 *  then shipped unworkletized and the app died at boot in installUnpackers
 *  ("Cannot read property 'code' of undefined": no __initData on the unpacker
 *  the plugin was supposed to generate). */
export const COMPILED_WORKLET_RE = /__workletHash\s*=\s*\d|__pluginVersion\s*=/;

/** Which files the pass considers at all: package sources on native. react-native
 *  CORE is excluded -- it ships no worklets, and makeStripFlowPlugin already
 *  claims those files with the full RN preset earlier in the stack. */
export const WORKLET_FILE_RE = /node_modules[/\\].*\.[cm]?[jt]sx?$/;

/** The two decisions this pass makes about a file, split out so they can be
 *  tested without an esbuild build. */
export function shouldWorkletize(filePath: string, src: string): boolean {
	if (RN_CORE_RE.test(filePath)) return false;
	if (!WORKLET_HINT_RE.test(src)) return false;
	if (COMPILED_WORKLET_RE.test(src)) return false;
	return true;
}

/** Babel parser plugins + esbuild loader for a package file's real extension.
 *  The loader must match the REAL extension: "tsx" on a .ts file parses
 *  generics like `useAnimatedRef<T>()` as JSX and fails. */
export function parserAndLoaderFor(filePath: string): {
	parserPlugins: ("typescript" | "jsx" | "flow")[];
	loader: esbuild.Loader;
} {
	const ext = filePath.slice(filePath.lastIndexOf(".") + 1).replace(/^[cm]/, "");
	if (ext === "ts") return { parserPlugins: ["typescript"], loader: "ts" };
	if (ext === "tsx") return { parserPlugins: ["typescript", "jsx"], loader: "tsx" };
	return { parserPlugins: ["flow", "jsx"], loader: "jsx" };
}

/** The app's worklets RUNTIME version for a build root, or null when the app
 *  has no reanimated/worklets at all.
 *
 *  Chunk caches must key on this: the factory shape and `__workletHash` are
 *  produced by a specific plugin version and checked by the matching runtime,
 *  so a chunk workletized against one version cannot be reused for another. */
export function workletsRuntimeVersion(root: string): string | null {
	for (const pkg of ["react-native-worklets", "react-native-reanimated"]) {
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(root, "node_modules", pkg, "package.json"), "utf8"));
			if (pkg === "react-native-worklets") return String(meta.version);
			// reanimated 4 moved worklets into its own package; reanimated 3 has
			// the plugin in-tree, so its own version is what the output matches.
			return `reanimated-${meta.version}`;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Whether a package's output can depend on the worklets plugin version.
 *  A package can only produce worklets if it uses reanimated, and every such
 *  package declares it (dependency or peerDependency) -- so the chunk keys of
 *  everything else stay stable across apps and keep sharing cache entries. */
export function mayWorkletize(pkgName: string, declaredDeps: string[]): boolean {
	return (
		pkgName === "react-native-reanimated" ||
		pkgName === "react-native-worklets" ||
		declaredDeps.some((d) => d === "react-native-reanimated" || d === "react-native-worklets")
	);
}

/** Worklet transform pass for package sources on native builds.
 *
 *  The plugin is resolved from the BUILD ROOT's own install so its version
 *  matches the app's worklets runtime; when the app has no reanimated at all
 *  the pass is inert (and, importantly, installs nothing -- see resolvePlugin).
 *
 *  disableSourceMaps: the plugin otherwise embeds sourcesContent by reading
 *  state.filename from disk, which doubles output size for zero dev value here
 *  (worklet code strings keep their location field regardless). */
export function makeWorkletsPlugin(platform: BuildPlatform): esbuild.Plugin {
	// Per-directory-tree plugin resolution cache (one entry per tmpdir).
	const pluginPathCache = new Map<string, Promise<string | null>>();

	const resolveNow = (root: string): string | null => {
		for (const spec of ["react-native-worklets/plugin", "react-native-reanimated/plugin"]) {
			try {
				const resolved = require.resolve(spec, { paths: [root] });
				// Pin BEFORE loading: the plugin resolves its babel packages from
				// its own location, and the load itself can be what picks a wrong
				// one.
				pinBabelForPlugin(resolved, root);
				// Must actually LOAD: reanimated 4.x ships a plugin/ shim that
				// re-exports react-native-worklets/plugin -- it resolves even when
				// the worklets peer is missing, then explodes inside babel.
				require(resolved);
				return resolved;
			} catch {
				/* try next */
			}
		}
		return null;
	};

	const resolvePlugin = (fromFile: string): Promise<string | null> => {
		// Find the install root (the path segment before node_modules).
		const idx = fromFile.lastIndexOf(`node_modules${path.sep}`);
		if (idx === -1) return Promise.resolve(null);
		const root = fromFile.slice(0, idx);
		let cached = pluginPathCache.get(root);
		if (!cached) {
			cached = (async () => {
				let resolved = resolveNow(root);
				if (!resolved) {
					// No reanimated in the build root means the app has no worklets
					// RUNTIME either: there is nothing to be compatible with, and the
					// hint regex matched something that merely looks like reanimated.
					// Installing a plugin here would spend ~2min to transform code
					// against a runtime that will never load it -- so don't.
					const range = reanimatedWorkletsPeerRange(root);
					if (range === null) return null;
					// Standalone /pkg builds install with --legacy-peer-deps, which
					// skips react-native-worklets (reanimated's peer). WITHOUT the
					// plugin the chunk ships unworkletized and crashes at runtime
					// ("Failed to create a worklet"), so installing the peer is the
					// only way that build can be correct.
					console.log(`[worklets] installing react-native-worklets@${range} into build root for the babel plugin`);
					try {
						await execFileAsync(
							"npm",
							["install", "--ignore-scripts", `react-native-worklets@${range}`, "--no-save", "--no-audit", "--no-fund"],
							{ cwd: root, killSignal: "SIGKILL", timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
						);
						resolved = resolveNow(root);
					} catch (err) {
						console.warn(`[worklets] peer install failed: ${(err as Error).message.slice(0, 200)}`);
					}
				}
				if (!resolved) console.warn(`[worklets] plugin not resolvable from ${root}; worklet files ship untransformed`);
				return resolved;
			})();
			pluginPathCache.set(root, cached);
		}
		return cached;
	};

	return {
		name: "workletize",
		setup(build) {
			if (platform === "web") return;
			build.onLoad({ filter: WORKLET_FILE_RE }, async (args) => {
				// Cheap path first: most package files never reach babel. The read is
				// the only cost esbuild would not have paid anyway.
				if (RN_CORE_RE.test(args.path)) return undefined;
				const src = await fs.promises.readFile(args.path, "utf8");
				if (!shouldWorkletize(args.path, src)) return undefined;
				const pluginPath = await resolvePlugin(args.path);
				if (!pluginPath) return undefined;
				const { parserPlugins, loader } = parserAndLoaderFor(args.path);
				try {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					const babel = require("@babel/core") as typeof import("@babel/core");
					const result = await babel.transformAsync(src, {
						filename: args.path,
						plugins: [[pluginPath, { disableSourceMaps: true }]],
						parserOpts: { plugins: parserPlugins },
						babelrc: false,
						configFile: false,
						compact: false,
						sourceMaps: false,
					});
					if (result?.code != null) return { contents: result.code, loader };
				} catch (err) {
					console.warn(`[worklets] transform failed for ${args.path}: ${(err as Error).message.slice(0, 200)}`);
				}
				return undefined;
			});
		},
	};
}

/** The @babel/core THIS process drives transforms with. Everything else babel
 *  needs resolves from inside its tree, so one consistent entry point is
 *  enough to pull a consistent set. */
const OUR_BABEL_CORE_DIR = path.dirname(require.resolve("@babel/core/package.json"));
const OUR_BABEL_MAJOR = semver.major(
	JSON.parse(fs.readFileSync(path.join(OUR_BABEL_CORE_DIR, "package.json"), "utf8")).version
);

/** Build roots whose plugin babel has already been settled (pinned or warned). */
export const babelPinned = new Set<string>();

/** Give the worklets plugin a babel tree that matches its own dependencies.
 *
 *  The plugin requires @babel/core, @babel/generator and friends from ITS OWN
 *  location, so it gets whatever the build root hoisted. `bun install` hoists
 *  a babel 8 SUBSET there (core, generator, parser, template, helpers,
 *  code-frame -- pulled in by metro's tree) while the plugin's own
 *  @babel/preset-typescript, @babel/types and @babel/traverse stay on 7. The
 *  plugin then dies per file: on .ts/.tsx inside assertVersion ("Requires
 *  Babel ^7.0.0-0, but was loaded with 8.0.6"), and on any file whose worklet
 *  body it re-prints inside the v8 generator ("Cannot read properties of
 *  undefined (reading 'length')" while printing a TS type node). Both are
 *  caught per file, so the chunk shipped unworkletized and only crashed on
 *  device -- react-native-reanimated's own src/*.ts included.
 *
 *  So: symlink OUR copies of the mismatched packages beside the plugin, where
 *  node resolution reaches them before anything hoisted. Node resolves a
 *  symlink to its real path, so each one's own requires then resolve inside
 *  our tree and the whole set is internally consistent. Only packages that
 *  actually disagree are linked, and only when ours is the major the plugin
 *  asks for -- a future babel-8 worklets plugin must not be dragged back to 7. */
export function pinBabelForPlugin(pluginPath: string, buildRoot: string): void {
	const owner = pluginBabelOwner(pluginPath);
	if (!owner || babelPinned.has(owner.dir)) return;
	babelPinned.add(owner.dir);
	const { dir: pkgDir, major: wantedMajor } = owner;

	const scopeDir = path.join(buildRoot, "node_modules", "@babel");
	let hoisted: string[];
	try {
		hoisted = fs.readdirSync(scopeDir);
	} catch {
		return;
	}

	const linked: string[] = [];
	const unfixable: string[] = [];
	for (const name of hoisted) {
		const theirs = majorOf(path.join(scopeDir, name, "package.json"));
		if (theirs === null || theirs === wantedMajor) continue;
		// Not every @babel/* package follows the monorepo's version line:
		// helper-define-polyfill-provider and the polyfill plugins are on 0.x.
		// Those are not the mismatch and must not be reported as one.
		if (theirs < 6) continue;
		let ourDir: string;
		try {
			ourDir = path.dirname(require.resolve(`@babel/${name}/package.json`));
		} catch {
			unfixable.push(`@babel/${name}@${theirs}`);
			continue;
		}
		if (majorOf(path.join(ourDir, "package.json")) !== wantedMajor) {
			unfixable.push(`@babel/${name}@${theirs}`);
			continue;
		}
		const link = path.join(pkgDir, "node_modules", "@babel", name);
		try {
			fs.mkdirSync(path.dirname(link), { recursive: true });
			fs.rmSync(link, { recursive: true, force: true });
			fs.symlinkSync(ourDir, link, "junction");
			linked.push(`@babel/${name}`);
		} catch (err) {
			unfixable.push(`@babel/${name} (${(err as Error).message.slice(0, 80)})`);
		}
	}

	if (linked.length) {
		console.log(
			`[worklets] pinned babel ${wantedMajor}.x for the plugin at ${pkgDir}: ${linked.join(", ")} ` +
				`(build root hoisted a different major)`
		);
	}
	if (unfixable.length) {
		// Loud: every one of these is a file that will ship unworkletized and
		// crash on device, and the per-file catch below would only whisper it.
		console.warn(
			`[worklets] could not pin ${unfixable.join(", ")} to ${wantedMajor}.x for ${pkgDir}` +
				(OUR_BABEL_MAJOR === wantedMajor ? "" : ` (this server is on babel ${OUR_BABEL_MAJOR}.x)`) +
				`; worklet transforms may fail`
		);
	}
}

/** Major version in a package.json, or null when it can't be read. */
function majorOf(pkgJsonPath: string): number | null {
	try {
		return semver.major(JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version);
	} catch {
		return null;
	}
}

/** The nearest package above the plugin entry point that declares which @babel
 *  major it is written against, and that major. Walking rather than taking the
 *  first package.json found matters: some plugins ship a bare `plugin/` folder
 *  with its own package.json and no dependencies of its own. */
function pluginBabelOwner(pluginPath: string): { dir: string; major: number } | null {
	const NAMES = ["@babel/preset-typescript", "@babel/types", "@babel/core"];
	let dir = path.dirname(pluginPath);
	for (let i = 0; i < 6; i++) {
		try {
			const deps = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies ?? {};
			for (const name of NAMES) {
				const min = deps[name] && semver.minVersion(deps[name]);
				if (min) return { dir, major: min.major };
			}
		} catch {
			/* no package.json here, or unreadable */
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** react-native-worklets range reanimated asks for in this build root, or null
 *  when reanimated isn't installed here at all. */
function reanimatedWorkletsPeerRange(root: string): string | null {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(root, "node_modules", "react-native-reanimated", "package.json"), "utf8")
		);
		return pkg.peerDependencies?.["react-native-worklets"] || "latest";
	} catch {
		return null;
	}
}
