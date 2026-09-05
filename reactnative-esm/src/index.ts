import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

// SECURITY: every subprocess in this file uses execFile/execFileSync with an
// argv ARRAY, never a shell string. `exec`/`execSync` spawn `/bin/sh -c` and
// interpolating a user-controlled package name/version into that string is an
// OS command injection (CVE-class: unauthenticated RCE). execFile passes each
// argument straight to execve with no shell, so a metacharacter in a package
// name is an inert literal, not a command. Do NOT reintroduce exec/execSync
// here. Input is ALSO validated (see isValidPackageName/isValidVersionRange)
// as a second layer.
//
// Async exec for long-running installs: the sync form blocks the WHOLE event
// loop (a 300s bun install froze every concurrent build in the process), so any
// install that can take more than a second must go through this.
const execFileAsync = promisify(execFile);

// bun install occasionally hangs under piped spawn until it is SIGKILLed. The
// old 300s bound meant a single hang cost 5 min, and the bun->bun->npm ladder
// stacked to ~11 min (observed 648393ms on the origin). With the common dep
// closure pre-warmed into bun's global cache (scripts/prewarm-bun-cache.mjs),
// an honest install of the shared set is seconds — so 90s is a stall signal,
// not a slow download, and we fail straight over to npm.
const BUN_INSTALL_TIMEOUT_MS = 90_000;
import esbuild from "esbuild";
// @ts-ignore - no type declarations
import flowRemoveTypes from "flow-remove-types";
import { sweepCache } from "./retention";
import { looseClassFields, normalizeBuildPaths, degradeIncompatibleAnimations } from "./output";
import { isValidPackageName, isValidVersionRange } from "./validation";
import { CODEGEN_SPEC_FILE_RE, RN_CORE_RE, codegenViewConfig } from "./codegen";
import {
	BuildPlatform,
	normalizePlatform,
	hashDepsServer,
	cacheKeyFor,
	esbuildPlatformSettings,
	rnEsbuildSettings,
	blankedPlatformsRe,
	NATIVE_DEPS_VERSION,
} from "./platform";

/**
 * esbuild.build wrapper that tolerates missing re-export bindings, mirroring
 * Metro/expo-web leniency.
 *
 * Some RN/Expo packages re-export names from a module that doesn't actually
 * export them — most often a `.web` build that omits exports the index
 * re-exports (e.g. expo-speech-recognition's `index.js` re-exports
 * `ExpoWebSpeechGrammar` from `./ExpoWebSpeechRecognition`, but the resolved
 * `ExpoWebSpeechRecognition.web.js` doesn't define it). Metro just makes the
 * binding `undefined` (it's never used on web); esbuild hard-errors with
 * "No matching export in X for import Y" and fails the ENTIRE package bundle,
 * which then never registers in browser-metro → runtime "Cannot read
 * properties of undefined (reading 'call')".
 *
 * We reproduce Metro's behavior: on that error, inject `export var <name> =
 * undefined;` into the offending module via an onLoad plugin and rebuild,
 * looping until the build is clean (or the error is something else).
 */
async function buildTolerant(
  options: esbuild.BuildOptions,
): Promise<esbuild.BuildResult> {
  // last-3-path-segments suffix -> set of export names to stub as undefined
  const stubs = new Map<string, Set<string>>();
  const norm = (p: string) => p.replace(/\\/g, "/");
  const suffix = (p: string) =>
    norm(p).split("/").filter(Boolean).slice(-3).join("/");

  const stubPlugin: esbuild.Plugin = {
    name: "tolerate-missing-reexports",
    setup(build) {
      build.onLoad({ filter: /\.([cm]?jsx?|tsx?)$/ }, async (args) => {
        let names: Set<string> | undefined;
        const p = norm(args.path);
        for (const [key, set] of stubs) {
          if (p === key || p.endsWith("/" + key)) {
            names = set;
            break;
          }
        }
        if (!names || names.size === 0) return undefined; // let default/other plugins handle
        let src = await fs.promises.readFile(args.path, "utf8");
        if (src.includes("@flow")) src = flowRemoveTypes(src).toString();
        for (const n of names) src += `\nexport var ${n} = undefined;`;
        const ext = path.extname(args.path);
        const loader: esbuild.Loader =
          ext === ".ts" ? "ts" : ext === ".tsx" ? "tsx" : "jsx";
        return { contents: src, loader };
      });
    },
  };

  const MAX_RETRIES = 16;
  for (let attempt = 0; ; attempt++) {
    try {
      return await esbuild.build({
        ...options,
        logLevel: "silent",
        plugins: [stubPlugin, ...(options.plugins ?? [])],
      });
    } catch (e: unknown) {
      const errs: esbuild.Message[] = (e as esbuild.BuildFailure)?.errors ?? [];
      let progressed = false;
      for (const er of errs) {
        const m = /No matching export in "([^"]+)" for import "([^"]+)"/.exec(
          er.text ?? "",
        );
        if (!m) continue;
        const key = suffix(m[1]);
        const name = m[2];
        if (!stubs.has(key)) stubs.set(key, new Set());
        const set = stubs.get(key)!;
        if (!set.has(name)) {
          set.add(name);
          progressed = true;
        }
      }
      // Unrelated error, no new stubs to add, or we've looped too long.
      if (!progressed || attempt >= MAX_RETRIES) throw e;
    }
  }
}

/**
 * Patch known upstream bugs in package sources as they are loaded.
 *
 * react-native-safe-area-context's WEB SafeAreaView mishandles a partial `edges`
 * prop. The native path normalises missing edges to 'off':
 *
 *   const requiredEdges = { top: edgesObj.top ?? 'off', bottom: edgesObj.bottom ?? 'off', ... }
 *
 * The web path (SafeAreaView.web.js) skips that step, so `edges={['top']}` yields
 * `{ top: 'additive' }` with `bottom` undefined. getEdgeValue's switch has no case
 * for undefined, so it falls through to `default:` — additive — and the bottom
 * inset is applied anyway. A screen that opted out of the bottom edge still gets
 * bottom-inset padding, stacking on top of a tab bar that already accounted for it.
 *
 * It only shows when insets are non-zero, which is why desktop web (all insets 0)
 * never revealed it while iOS Safari with viewport-fit=cover does.
 *
 * Fix mirrors native: treat a missing mode as 'off'. Anchored on the switch's
 * 'off' case; if upstream refactors, this logs instead of silently shipping an
 * unpatched build.
 *
 * VERSION BOUNDARY — only needed for react-native-safe-area-context < 5.7.0.
 * Upstream fixed this in 5.7.0 by reordering the switch so `default` falls in
 * with 'off'. The patch is a verified no-op on 5.7.0+: the anchor still matches,
 * but inserting `case undefined:` above a branch that already returns `current`
 * changes nothing (checked against 5.6.2 / 5.7.0 / 5.8.0 across all four modes —
 * only 5.6.2 changes behaviour).
 *
 * It is kept because existing projects still pin older versions (our templates
 * pinned 5.6.1, and live traffic spans 4.12.0 through 5.8.0), so they need this
 * until they upgrade. Safe to delete once nothing below 5.7.0 is in use.
 */
/**
 * Preview shims — make web builds report state the preview UI needs.
 *
 * expo-status-bar does nothing observable on web. That is correct for a real
 * browser (no OS status bar), but the editor draws a simulated iOS status bar
 * over the preview, and `<StatusBar style="light" />` is exactly what decides
 * its ink colour on a device. With nothing in the DOM to observe, the chrome has
 * to guess from the app's colour scheme, and disagrees whenever an app declares
 * a style that opposes its theme.
 *
 * Target note: the shim wraps `src/StatusBar.ts`, NOT `StatusBar.web.ts`. The
 * package's `exports` map points at an exact path ("./src/StatusBar.ts"), which
 * bypasses resolveExtensions entirely — so the `.web.ts` variant is never loaded
 * and patching it would silently do nothing. StatusBar.ts is a thin barrel over
 * NativeStatusBarWrapper, so we re-export through it and add the broadcast,
 * leaving upstream behaviour intact rather than replacing an implementation.
 *
 * State is published two ways because the two previews differ in origin:
 *   - a data attribute on <html>, for the canvas iframe (same-origin, readable)
 *   - a postMessage to the parent, for the Preview browser (cross-origin)
 *
 * Declarations are kept on a stack, as native does: the last mounted StatusBar
 * wins and unmounting pops back to the screen underneath, so a route change
 * restores the previous colours instead of leaving the last style stuck.
 */
const previewShimsPlugin: esbuild.Plugin = {
	name: "preview-shims",
	setup(build) {
		build.onLoad(
			{ filter: /expo-status-bar[/\\]src[/\\]StatusBar\.[jt]sx?$/ },
			async (args) => {
				const source = await fs.promises.readFile(args.path, "utf8");
				// Guard: only wrap the known re-export barrel. If upstream restructures,
				// leave it alone and say so rather than clobbering real code.
				if (!source.includes("from './NativeStatusBarWrapper'")) {
					console.warn(
						`[preview-shims] expo-status-bar shim skipped — not the expected barrel: ${args.path}`
					);
					return null;
				}

				const contents = `
import * as React from 'react';
import {
  StatusBar as __rnUpstreamStatusBar,
  setStatusBarStyle as __rnUpstreamSetStyle,
  setStatusBarHidden as __rnUpstreamSetHidden,
  setStatusBarBackgroundColor,
  setStatusBarNetworkActivityIndicatorVisible,
  setStatusBarTranslucent,
} from './NativeStatusBarWrapper';

// Declaration stack, mirroring native. React Native keeps every mounted
// StatusBar's props on a stack and the last one wins, so unmounting restores
// whatever the screen underneath asked for. Without this, navigating away from a
// screen that set a style leaves that style stuck — the previous behaviour, and
// the reason a route change did not restore the chrome's colours.
var __rnSeq = 0;
var __rnStack = [];

// Imperative setStatusBar*() calls sit on top of the stack. Cleared whenever the
// stack changes, so a navigation re-derives from the mounted declarations rather
// than inheriting an imperative call made on a screen that is gone.
var __rnImperative = null;

function __rnEffectiveStatusBar() {
  var top = __rnStack.length ? __rnStack[__rnStack.length - 1] : null;
  var style = top ? top.style : null;
  var hidden = top ? top.hidden : false;
  if (__rnImperative) {
    if ('style' in __rnImperative) style = __rnImperative.style;
    if ('hidden' in __rnImperative) hidden = __rnImperative.hidden;
  }
  return { style: style, hidden: hidden };
}

function __rnPublishStatusBar() {
  try {
    var eff = __rnEffectiveStatusBar();
    if (typeof document === 'undefined') return;
    var root = document.documentElement;
    if (eff.style == null) {
      delete root.dataset.rnStatusBarStyle;
    } else {
      root.dataset.rnStatusBarStyle = String(eff.style);
    }
    root.dataset.rnStatusBarHidden = eff.hidden ? '1' : '0';
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage({
        source: 'rapidnative-preview',
        type: 'status-bar',
        style: eff.style,
        hidden: !!eff.hidden,
      }, '*');
    }
  } catch (e) {}
}

// Re-registering by id (rather than pushing again) keeps a prop change from
// growing the stack, while still moving that entry to the top.
function __rnRegisterStatusBar(id, style, hidden) {
  __rnStack = __rnStack.filter(function (e) { return e.id !== id; });
  __rnStack.push({ id: id, style: style, hidden: hidden });
  __rnImperative = null;
  __rnPublishStatusBar();
}

function __rnUnregisterStatusBar(id) {
  __rnStack = __rnStack.filter(function (e) { return e.id !== id; });
  __rnImperative = null;
  __rnPublishStatusBar();
}

export function StatusBar(props) {
  var idRef = React.useRef(null);
  if (idRef.current === null) idRef.current = ++__rnSeq;
  var style = props && props.style != null ? props.style : null;
  var hidden = !!(props && props.hidden);
  React.useEffect(function () {
    __rnRegisterStatusBar(idRef.current, style, hidden);
    return function () { __rnUnregisterStatusBar(idRef.current); };
  }, [style, hidden]);
  return React.createElement(__rnUpstreamStatusBar, props);
}

export function setStatusBarStyle(style, animated) {
  __rnImperative = Object.assign({}, __rnImperative, { style: style == null ? null : style });
  __rnPublishStatusBar();
  return __rnUpstreamSetStyle(style, animated);
}

export function setStatusBarHidden(hidden, animation) {
  __rnImperative = Object.assign({}, __rnImperative, { hidden: !!hidden });
  __rnPublishStatusBar();
  return __rnUpstreamSetHidden(hidden, animation);
}

export {
  setStatusBarBackgroundColor,
  setStatusBarNetworkActivityIndicatorVisible,
  setStatusBarTranslucent,
};

export { StatusBarStyle, StatusBarAnimation, StatusBarProps } from './types';
`;
				return { contents, loader: "ts" };
			}
		);
	},
};

const patchUpstreamBugsPlugin: esbuild.Plugin = {
	name: "patch-upstream-bugs",
	setup(build) {
		build.onLoad(
			{ filter: /react-native-safe-area-context[/\\].*SafeAreaView\.web\.[jt]sx?$/ },
			async (args) => {
				const source = await fs.promises.readFile(args.path, "utf8");
				const anchor = /case\s+(['"])off\1\s*:/;
				if (!anchor.test(source)) {
					console.warn(
						`[patch-upstream-bugs] SafeAreaView.web edges patch did not apply (anchor missing): ${args.path}`
					);
					return null;
				}
				const patched = source.replace(
					anchor,
					(m) => `case undefined:\n    // patched: a missing edge means 'off', as in the native path\n    ${m}`
				);
				return { contents: patched, loader: "jsx" };
			}
		);
	},
};

/**
 * Hermes (Expo Go's engine) is NOT the es2018 engine it first appears to be
 * (all verified against RN 0.81's hermesc + on-device):
 *   - `class` syntax is rejected outright (and esbuild cannot lower it);
 *   - async ARROW functions are rejected (plain `async function` parses);
 *   - `let`/`const` compile as `var` WITHOUT per-iteration loop bindings, so
 *     esbuild's own `__copyProps` helper (`for (let key of ...)` + getter
 *     closures) silently makes EVERY re-exported property return the last
 *     key's value. This one only shows at runtime, on device.
 * Native chunks therefore get one babel pass over the finished output:
 * classes -> functions, async -> generators, block scoping -> closures with
 * correct per-iteration capture. One parse per chunk, once per package
 * version, then cached.
 */
async function lowerClassesForHermes(code: string, platform: BuildPlatform): Promise<string> {
	if (platform === "web") return code;
	code = looseClassFields(code, "native chunk");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const babel = require("@babel/core") as typeof import("@babel/core");
	const result = await babel.transformAsync(code, {
		plugins: [
			require.resolve("@babel/plugin-transform-classes"),
			require.resolve("@babel/plugin-transform-async-generator-functions"),
			require.resolve("@babel/plugin-transform-async-to-generator"),
			require.resolve("@babel/plugin-transform-block-scoping"),
		],
		babelrc: false,
		configFile: false,
		compact: false,
		sourceMaps: false,
		// The chunks are plain scripts (IIFEs), not modules.
		sourceType: "script",
	});
	if (result?.code == null) throw new Error("lowerClassesForHermes: babel produced no output");
	return result.code;
}

/** Platform-SELECTING replacement for the old blanket native filter. */
function makeFilterPlatformsPlugin(platform: BuildPlatform): esbuild.Plugin {
	const re = blankedPlatformsRe(platform);
	return {
		name: "filter-native-platforms",
		setup(build) {
			build.onLoad({ filter: re }, () => ({ contents: "", loader: "js" }));
		},
	};
}

/** Flow stripping. Web keeps the @flow-pragma-only rule (cache compat).
 *
 *  Native react-native core is a different beast: it ships Flow LANGUAGE
 *  features (component syntax, Flow enums) that flow-remove-types cannot
 *  lower -- it only erases type positions. Metro compiles RN core with
 *  @react-native/babel-preset in every real app, so we do the same for
 *  files inside the react-native package. Slow-ish (~10-20s across the
 *  package) but it runs once per RN version and is cached. */
function makeStripFlowPlugin(platform: BuildPlatform): esbuild.Plugin {
	return {
		name: "strip-flow",
		setup(build) {
			build.onLoad({ filter: /\.jsx?$/ }, async (args) => {
				const src = await fs.promises.readFile(args.path, "utf8");
				if (platform !== "web" && /node_modules[/\\]react-native[/\\]/.test(args.path)) {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					const babel = require("@babel/core") as typeof import("@babel/core");
					const result = await babel.transformAsync(src, {
						filename: args.path,
						presets: [[require.resolve("@react-native/babel-preset"), { enableBabelRuntime: false }]],
						babelrc: false,
						configFile: false,
						compact: false,
						sourceMaps: false,
					});
					if (result?.code != null) {
						return { contents: result.code, loader: "js" };
					}
					console.warn(`[strip-flow] babel produced no output for ${args.path}; falling through`);
					return undefined;
				}
				if (src.includes("@flow")) {
					return { contents: flowRemoveTypes(src).toString(), loader: "jsx" };
				}
				return undefined;
			});
		},
	};
}

// Stub Node.js built-ins that some RN packages import but don't actually
// need at runtime (e.g. react-native-svg imports "buffer"). Hermes has no
// node builtins at all, so this applies to every native build.
const nodeBuiltins = new Set([
	"buffer", "stream", "path", "fs", "os", "crypto", "util",
	"events", "http", "https", "net", "tls", "zlib", "url",
	"querystring", "assert", "child_process", "cluster",
	"dgram", "dns", "domain", "readline", "tty", "v8", "vm",
	"worker_threads", "perf_hooks", "string_decoder",
]);
const stubNodeBuiltinsPlugin: esbuild.Plugin = {
	name: "stub-node-builtins",
	setup(build) {
		build.onResolve({ filter: /.*/ }, (args) => {
			if (nodeBuiltins.has(args.path) || args.path.startsWith("node:")) {
				return { path: args.path, namespace: "node-stub" };
			}
			return null;
		});
		build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
			contents: "module.exports = {};",
			loader: "js",
		}));
	},
};

/** Worklet transforms for packages that ship raw 'worklet' directives
 *  (react-native-reanimated has ~80 such files; react-native-worklets ~17).
 *  Metro runs react-native-worklets/plugin over ALL files via babel.config;
 *  here it runs only on files that can contain worklets (cheap regex gate)
 *  and only on native builds. The plugin is resolved from the build's own
 *  install so its version matches the app's worklets runtime; if it isn't
 *  installed there (project doesn't use reanimated), the plugin is inert.
 *
 *  disableSourceMaps: the plugin otherwise embeds sourcesContent by reading
 *  state.filename from disk, which doubles output size for zero dev value
 *  here (worklet code strings keep their location field regardless). */
const WORKLET_HINT_RE = /['"]worklet['"]/;
function makeWorkletsPlugin(platform: BuildPlatform): esbuild.Plugin {
	// Per-directory-tree plugin resolution cache (one entry per tmpdir).
	const pluginPathCache = new Map<string, Promise<string | null>>();
	const resolveNow = (root: string): string | null => {
		for (const spec of ["react-native-worklets/plugin", "react-native-reanimated/plugin"]) {
			try {
				const resolved = require.resolve(spec, { paths: [root] });
				// Must actually LOAD: reanimated 4.x ships a plugin/ shim that
				// re-exports react-native-worklets/plugin -- it resolves even when
				// the worklets peer is missing, then explodes inside babel.
				require(resolved);
				return resolved;
			} catch { /* try next */ }
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
					// Standalone /pkg builds install with --legacy-peer-deps, which
					// skips react-native-worklets (reanimated's peer). WITHOUT the
					// plugin the chunk ships unworkletized and crashes at runtime
					// ("Failed to create a worklet"), so failing the build would be
					// better than skipping -- but installing the peer fixes it.
					const range = (() => {
						try {
							const pkg = JSON.parse(
								fs.readFileSync(path.join(root, "node_modules", "react-native-reanimated", "package.json"), "utf8")
							);
							return pkg.peerDependencies?.["react-native-worklets"] || "latest";
						} catch {
							return "latest";
						}
					})();
					console.log(`[worklets] installing react-native-worklets@${range} into build root for the babel plugin`);
					try {
						await execFileAsync("npm", ["install", "--ignore-scripts", `react-native-worklets@${range}`, "--no-save", "--no-audit", "--no-fund"], {
							cwd: root,
							killSignal: "SIGKILL",
							timeout: 120000,
							maxBuffer: 16 * 1024 * 1024,
						});
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
			build.onLoad({ filter: /node_modules[/\\](react-native-reanimated|react-native-worklets)[/\\].*\.[cm]?[jt]sx?$/ }, async (args) => {
				const src = await fs.promises.readFile(args.path, "utf8");
				if (!WORKLET_HINT_RE.test(src)) return undefined;
				const pluginPath = await resolvePlugin(args.path);
				if (!pluginPath) return undefined;
				const ext = args.path.slice(args.path.lastIndexOf(".") + 1).replace(/^[cm]/, "");
				const parserPlugins: ("typescript" | "jsx" | "flow")[] =
					ext === "ts" ? ["typescript"] : ext === "tsx" ? ["typescript", "jsx"] : ["flow", "jsx"];
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
					if (result?.code != null) {
						// Loader must match the REAL extension: "tsx" on a .ts file
						// parses generics like useAnimatedRef<T>() as JSX and fails.
						const loader = (ext === "ts" ? "ts" : ext === "tsx" ? "tsx" : "jsx") as esbuild.Loader;
						return { contents: result.code, loader };
					}
				} catch (err) {
					console.warn(`[worklets] transform failed for ${args.path}: ${(err as Error).message.slice(0, 200)}`);
				}
				return undefined;
			});
		},
	};
}

/** codegenNativeComponent -> static JS view config (New Architecture).
 *
 *  On the New Architecture / bridgeless, RN's `codegenNativeComponent` REQUIRES
 *  the build-time codegen transform or the component crashes with
 *  `Invariant Violation: View config not found for component <Name>`. Metro runs
 *  @react-native/babel-plugin-codegen (part of @react-native/babel-preset) over
 *  every package; we do the same, narrowly. See src/codegen.ts for the full
 *  rationale, the two filename conventions, and the loud log-and-skip.
 *
 *  Scope: native only (web gets these components from react-native-web).
 *  react-native CORE is excluded: makeStripFlowPlugin already runs the full
 *  preset (codegen included) over the react-native package and, being earlier
 *  in the stack, claims those files first. Output mirrors makeStripFlowPlugin
 *  (preset -> loader "js"). */
function makeCodegenPlugin(platform: BuildPlatform): esbuild.Plugin {
	return {
		name: "codegen-native-component",
		setup(build) {
			if (platform === "web") return;
			build.onLoad({ filter: CODEGEN_SPEC_FILE_RE }, async (args) => {
				if (RN_CORE_RE.test(args.path)) return undefined;
				const src = await fs.promises.readFile(args.path, "utf8");
				const code = await codegenViewConfig(src, args.path);
				return code != null ? { contents: code, loader: "js" } : undefined;
			});
		},
	};
}

/** The plugin stack for RN/Expo package builds on a given platform.
 *  previewShims is web-only (it feeds the RapidNative editor's simulated
 *  chrome via DOM/postMessage -- meaningless and unwanted on a device).
 *  patchUpstreamBugs anchors on .web.* files, so it is inert on native but
 *  registered everywhere per the repo convention. */
function rnPluginStack(platform: BuildPlatform, site: "pkg" | "batch" = "batch"): esbuild.Plugin[] {
	return [
		makeStripFlowPlugin(platform),
		makeFilterPlatformsPlugin(platform),
		// After filterPlatforms so blanked platform variants stay blanked
		// (esbuild uses the first onLoad that returns contents).
		makeWorkletsPlugin(platform),
		// After stripFlow so react-native core specs are claimed by the full
		// preset there; this pass covers non-core packages (react-native-screens
		// etc.) whose NativeComponent specs esbuild would otherwise ship raw.
		makeCodegenPlugin(platform),
		// Node-builtin stubbing scope preserves the HISTORICAL web behavior:
		// only the /pkg path ever stubbed on web -- batch builds resolved the
		// real npm polyfills (buffer/events/util) that some packages depend on,
		// and widening the stub there would change new web batch builds. Native
		// (Hermes, no builtins at all) stubs everywhere.
		...(platform !== "web" || site === "pkg" ? [stubNodeBuiltinsPlugin] : []),
		patchUpstreamBugsPlugin,
		...(platform === "web" ? [previewShimsPlugin] : []),
	];
}

const app = express();
const CACHE_DIR = path.join(__dirname, "..", "cache");
const PORT = 5200;

// Ensure cache dir exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-For) from nginx/Cloudflare
app.set("trust proxy", true);

// JSON body parser for POST endpoints
// 10mb: /nativewind-css posts project source files for tailwind content
// scanning; /bundle-deps bodies stay tiny.
app.use(express.json({ limit: "10mb" }));

// CORS for browser access
app.use((req: Request, res: Response, next: NextFunction) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	res.header("Access-Control-Expose-Headers", "X-Externals");
	if (req.method === "OPTIONS") { res.sendStatus(204); return; }
	next();
});

// Parse unpkg-style specifier into { pkgName, version, subpath }
function parseSpecifier(raw: string) {
	let pkgName: string;
	let version: string;
	let subpath: string = "";

	if (raw.startsWith("@")) {
		// Scoped: @scope/name@ver/sub
		const slashIdx = raw.indexOf("/");
		if (slashIdx === -1) return null;
		const secondSlash = raw.indexOf("/", slashIdx + 1);
		if (secondSlash === -1) {
			pkgName = raw;
		} else {
			pkgName = raw.slice(0, secondSlash);
			subpath = raw.slice(secondSlash);
		}
	} else {
		const slashIdx = raw.indexOf("/");
		if (slashIdx === -1) {
			pkgName = raw;
		} else {
			pkgName = raw.slice(0, slashIdx);
			subpath = raw.slice(slashIdx);
		}
	}

	// Extract version from pkgName
	const atIdx = pkgName.lastIndexOf("@");
	if (atIdx > 0) {
		version = pkgName.slice(atIdx + 1);
		pkgName = pkgName.slice(0, atIdx);
	} else {
		version = "latest";
	}

	// SECURITY: reject non-canonical names/versions -> caller returns 400 before
	// pkgName/version reach npm (subprocess) or path.join (filesystem).
	if (!isValidPackageName(pkgName) || !isValidVersionRange(version)) return null;

	return { pkgName, version, subpath };
}

// Bundle and serve an npm package

// Dist-tag / range → exact version cache with TTL (default 5 min).
// Prevents repeated npm registry lookups for the same "latest" request.
const DIST_TAG_TTL_MS = 5 * 60 * 1000;
const distTagCache = new Map<string, { version: string; ts: number }>();

// Check whether a version string is a semver range or dist-tag.
// Anything that isn't a plain x.y.z(-pre)? is treated as needing resolution.
function needsResolution(version: string): boolean {
	return /[~^<>=*| ]/.test(version) || !/^\d+\.\d+\.\d+/.test(version);
}

// Check if a version string is a dist-tag (e.g. "latest", "next", "beta")
// as opposed to a semver range (e.g. "^1.0.0", "~2.3.0", ">=1.0.0")
function isDistTag(version: string): boolean {
	return /^[a-zA-Z]/.test(version) && !/[~^<>=*| ]/.test(version);
}

// Resolve a semver range or dist-tag to an exact version.
// For dist-tags: uses the npm registry HTTP API (async, ~200-500ms) with a TTL cache.
// For semver ranges: falls back to sync `npm view` (slower but handles complex ranges).
async function resolveVersionAsync(pkgName: string, range: string): Promise<string | null> {
	const cacheKey = `${pkgName}@${range}`;
	const cached = distTagCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < DIST_TAG_TTL_MS) {
		return cached.version;
	}

	// Fast path for dist-tags: hit npm registry HTTP API directly
	if (isDistTag(range)) {
		try {
			const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(pkgName).replace("%40", "@")}/${encodeURIComponent(range)}`;
			const resp = await fetch(registryUrl, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(5000),
			});
			if (resp.ok) {
				const data = await resp.json() as { version?: string };
				if (data.version) {
					distTagCache.set(cacheKey, { version: data.version, ts: Date.now() });
					return data.version;
				}
			}
		} catch { /* fall through to npm view fallback */ }
	}

	// Fallback: npm view (handles semver ranges and dist-tags if HTTP failed).
	// execFileSync (argv array, no shell) — pkgName/range are never interpolated
	// into a command string.
	try {
		const result = execFileSync("npm", ["view", `${pkgName}@${range}`, "version"], {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		}).toString().trim();
		// npm view can return multiple lines for ranges; take the last (highest)
		const lines = result.split("\n");
		const resolved = lines[lines.length - 1].replace(/^'|'$/g, "").trim();
		if (resolved) {
			distTagCache.set(cacheKey, { version: resolved, ts: Date.now() });
		}
		return resolved || null;
	} catch {
		return null;
	}
}


function serveCached(res: Response, cacheFile: string, externalsFile: string, label: string): boolean {
	if (!fs.existsSync(cacheFile)) return false;
	console.log(`[cache hit] ${label}`);
	if (fs.existsSync(externalsFile)) {
		res.header("X-Externals", fs.readFileSync(externalsFile, "utf-8"));
	}
	res.header("Cache-Control", "public, max-age=31536000, immutable");
	res.type("application/javascript").sendFile(cacheFile);
	return true;
}

// Node-side build tooling that RN app code can transitively reference (e.g.
// nativewind's exports pull @expo/metro-config) but that can NEVER run under
// Hermes. Attempting to bundle them costs an npm install + a guaranteed
// esbuild failure per request; native gets an immediate cacheable stub
// instead. Web is untouched (historical behavior preserved).
const NATIVE_TOOL_STUBS = new Set([
	"metro",
	"metro-config",
	"metro-core",
	"metro-cache",
	"metro-resolver",
	"metro-transform-worker",
	"@expo/metro-config",
	"@expo/cli",
	"@react-native/metro-config",
	"babel-plugin-module-resolver",
	"@babel/core",
	"lightningcss",
	"postcss",
	"autoprefixer",
]);

// Build-time-only packages a CLIENT bundle never requires at runtime. Unlike
// NATIVE_TOOL_STUBS (native-only, and consulted on the /pkg path), these must
// be stubbed in the /bundle-deps path on BOTH platforms: they're regular
// direct deps of the project, so the deps loop tries to esbuild them, they
// pull Node builtins (fs/path/stream/events via @nodelib etc.) that don't
// resolve in a browser/Hermes build, and esbuild fails with 60+ "Could not
// resolve" lines before the existing catch falls back to a `{}` stub anyway.
// tailwindcss is in essentially every nativewind project (2,743 of 2,752 in
// the fleet), so that wasted install + guaranteed-failing build + log spew
// fires on almost every build. Stubbing up front reaches the identical end
// state (module.exports = {}) without the wasted work. nativewind consumes the
// server-compiled CSS from /nativewind-css, never tailwindcss at runtime.
const CLIENT_EXCLUDED_BUILD_TOOLS = new Set([
	"tailwindcss",
	"@tailwindcss/postcss",
	"postcss",
	"autoprefixer",
	"lightningcss",
]);

async function handlePkgRequest(res: Response, pkgName: string, version: string, subpath: string, baseUrl?: string, platform: BuildPlatform = "web") {
	// browser-metro's overrideModules hook keeps the real module reachable under
	// a synthetic "<name>__original" key so a wrapper can delegate to it. That
	// key is CLIENT-side bookkeeping and must never reach us -- but when the
	// client's module map doesn't already hold the wrapped package, its
	// transitive scan treats the synthetic name as an npm specifier and fetches
	// it. Resolution then fails here, esbuild externalises the base package, and
	// we serve a ~1KB stub instead of the module: on device the first JSX call
	// throws "Cannot read property 'call' of undefined" and the app renders
	// blank with no redbox. Three production projects hit exactly this.
	//
	// The client's intent is unambiguous -- it wants the original module -- so
	// serve it. This repairs already-deployed clients that cannot be rolled
	// forward, and stays harmless once they stop asking.
	if (subpath.endsWith("__original")) {
		const real = subpath.slice(0, -"__original".length);
		console.log(`[pkg] serving ${pkgName}${real} for synthetic ${pkgName}${subpath}${platform === "web" ? "" : ` [${platform}]`}`);
		subpath = real;
	}
	const requireSpecifier = pkgName + subpath;
	const platLabel = platform === "web" ? "" : ` [${platform}]`;

	if (platform !== "web" && NATIVE_TOOL_STUBS.has(pkgName)) {
		console.log(`[tool stub] ${requireSpecifier}${platLabel}`);
		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.header("X-Externals", "{}");
		res.type("application/javascript").send(
			`// ${requireSpecifier}: Node-side build tooling, stubbed on ${platform}\nmodule.exports = {};\n`
		);
		return;
	}

	// 1. Check exact cache (works for exact versions like "6.0.12")
	const exactKey = cacheKeyFor(pkgName, version, subpath, platform);
	const exactCache = path.join(CACHE_DIR, `${exactKey}.js`);
	const exactExternals = path.join(CACHE_DIR, `${exactKey}.externals.json`);
	if (serveCached(res, exactCache, exactExternals, `${requireSpecifier}@${version}${platLabel}`)) return;

	// 2. For semver ranges / dist-tags, resolve to exact version and check cache
	let resolvedVersion = version;
	if (needsResolution(version)) {
		const resolved = await resolveVersionAsync(pkgName, version);
		if (resolved && resolved !== version) {
			resolvedVersion = resolved;
			const resolvedKey = cacheKeyFor(pkgName, resolvedVersion, subpath, platform);
			const resolvedCache = path.join(CACHE_DIR, `${resolvedKey}.js`);
			const resolvedExternals = path.join(CACHE_DIR, `${resolvedKey}.externals.json`);
			if (serveCached(res, resolvedCache, resolvedExternals, `${requireSpecifier}@${resolvedVersion}${platLabel} (resolved from ${version})`)) return;
		}
	}

	// 3. No cache - install and bundle
	console.log(`[bundling] ${requireSpecifier}@${version}${platLabel}`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));

	try {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "pkg-tmp", version: "1.0.0" }));
		await execFileAsync("npm", ["install", "--ignore-scripts", `${pkgName}@${version}`, "--legacy-peer-deps", "--no-audit", "--no-fund"], {
			cwd: tmpDir,
			killSignal: "SIGKILL",
			timeout: 180000,
			maxBuffer: 16 * 1024 * 1024,
		});

		// Get the actual installed version
		const installedPkgJson = path.join(tmpDir, "node_modules", pkgName, "package.json");
		if (fs.existsSync(installedPkgJson)) {
			const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
			if (meta.version) resolvedVersion = meta.version;
		}

		// Final cache key uses resolved exact version
		const finalKey = cacheKeyFor(pkgName, resolvedVersion, subpath, platform);
		const finalCacheFile = path.join(CACHE_DIR, `${finalKey}.js`);
		const finalExternalsFile = path.join(CACHE_DIR, `${finalKey}.externals.json`);

		// Read package metadata to detect RN/Expo packages and collect externals.
		// We externalize ALL dependencies (not just peerDependencies) so that
		// shared transitive deps (e.g. @react-navigation/core) are loaded once
		// at runtime rather than inlined into every bundle that uses them.
		let externals: string[] = [];
		let isReactNative = false;
		let keywords: string[] = [];
		if (fs.existsSync(installedPkgJson)) {
			const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
			const deps = Object.keys(meta.dependencies || {});
			const peerDeps = Object.keys(meta.peerDependencies || {});
			externals = [...new Set([...deps, ...peerDeps])];
			keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
			isReactNative =
				pkgName.startsWith("@expo/") ||
				pkgName.startsWith("@expo-google-fonts/") ||
				pkgName.includes("react-native") ||
				keywords.some((k: string) => k === "react-native" || k === "expo");

			// For RN/Expo packages: don't externalize @react-native/* utility
			// packages (e.g. @react-native/normalize-colors) that are installed
			// as direct deps - they should be inlined since they're small utils.
			// They'll only be externalized by the plugin if not locally resolvable.
			if (isReactNative) {
				externals = externals.filter(dep => !dep.startsWith("@react-native/"));
			}
		}

		if (isReactNative) {
			// Always externalize react-native and Expo platform modules for RN/Expo
			// packages. Many packages use these without listing them as deps,
			// expecting them to be available via the Expo/RN runtime.
			const implicitExternals = [
				"react-native", "react", "react-dom",
				"expo", "expo-modules-core", "expo-modules-autolinking",
				"expo-constants", "expo-linking", "expo-status-bar",
				"expo-splash-screen", "expo-font", "expo-asset",
			];
			for (const dep of implicitExternals) {
				if (!externals.includes(dep)) externals.push(dep);
			}

			// Scan node_modules for any @react-native/* and @expo/* scoped
			// packages and externalize them - they're platform modules that
			// should be loaded at runtime, not inlined.
			for (const scope of ["@react-native", "@expo"]) {
				const scopeDir = path.join(tmpDir, "node_modules", scope);
				if (fs.existsSync(scopeDir)) {
					for (const entry of fs.readdirSync(scopeDir)) {
						const scopedName = `${scope}/${entry}`;
						if (!externals.includes(scopedName)) externals.push(scopedName);
					}
				}
			}
		}

		// Don't externalize a package from itself (would create circular require).
		externals = externals.filter((dep) => dep !== requireSpecifier && !requireSpecifier.startsWith(dep + "/"));

		// NATIVE react-native core build: everything inlines EXCEPT react (peer,
		// one instance app-wide) and @react-native/assets-registry (must be a
		// shared singleton so app asset modules and RN's resolveAssetSource read
		// the same registry). In particular metro-runtime and react-refresh MUST
		// inline -- InitializeCore requires them at runtime and there is no
		// ambient copy in a fresh Hermes instance.
		if (platform !== "web" && pkgName === "react-native") {
			externals = ["react", "@react-native/assets-registry"];
		}

		const entryFile = path.join(tmpDir, "__entry.js");
		fs.writeFileSync(
			entryFile,
			`module.exports = require("${requireSpecifier}");\n`
		);

		// Externalize bare package imports (e.g. "react") so shared deps are
		// loaded once. For subpath imports (e.g. "css-in-js-utils/lib/foo"),
		// generally inline them since they're internal implementation details.
		// Exception: react/react-dom/react-native subpaths are always externalized
		// because inlining them embeds version-sensitive code from the temp dir.
		const externalSet = new Set(externals);
		// Track which deps were actually externalized and their installed versions.
		// This map is sent as the X-Externals response header so the bundler can
		// fetch transitive deps at pinned versions instead of @latest.
		const externalizedMap: Record<string, string> = {};

		function getInstalledVersion(pkg: string): string | null {
			try {
				const depPkgJson = path.join(tmpDir, "node_modules", pkg, "package.json");
				const depMeta = JSON.parse(fs.readFileSync(depPkgJson, "utf-8"));
				return depMeta.version;
			} catch {
				return null;
			}
		}

		// Packages whose subpath imports must also be externalized to avoid
		// inlining version-sensitive code from the temp dir (e.g. react-dom/client
		// contains a version check against require("react").version).
		const alwaysExternalSubpaths = new Set(["react", "react-dom", "react-native"]);

		// Flow stripping, platform file filtering and node-builtin stubs are the
		// hoisted platform-aware plugins (see rnPluginStack above).

		const selectiveExternalPlugin: esbuild.Plugin = {
			name: "selective-external",
			setup(build) {
				build.onResolve({ filter: /^[^./]/ }, (args) => {
					let pkg: string;
					if (args.path.startsWith("@")) {
						const parts = args.path.split("/");
						pkg = parts.length >= 2 ? parts.slice(0, 2).join("/") : args.path;
					} else {
						pkg = args.path.split("/")[0];
					}

					// Native: the assets registry must stay a shared singleton even
					// when a package happens to have it locally resolvable.
					if (platform !== "web" && pkg === "@react-native/assets-registry" && pkg !== requireSpecifier && !requireSpecifier.startsWith(pkg + "/")) {
						if (!externalizedMap[pkg]) {
							const v = getInstalledVersion(pkg);
							if (v) externalizedMap[pkg] = v;
						}
						return { path: args.path, external: true };
					}

					// For RN/Expo builds, externalize @react-native/* and @expo/*
					// scoped packages that can't be resolved locally. If they're
					// installed (e.g. @react-native/normalize-colors as a dep of
					// react-native-web), let esbuild inline them.
					if (isReactNative && !externalSet.has(pkg) && (pkg.startsWith("@react-native/") || pkg.startsWith("@expo/"))) {
						try {
							require.resolve(args.path, { paths: [args.resolveDir] });
							return null; // resolvable locally - inline it
						} catch {
							return { path: args.path, external: true }; // not installed - externalize
						}
					}

					if (!externalSet.has(pkg)) {
						// Native leniency: optional peers of inlined transitive deps
						// (e.g. react-native-reanimated lazily required by
						// react-native-css-interop) aren't installed here and aren't in
						// the external set. Externalize instead of failing the build --
						// the client resolves them from the app's own dependencies.
						if (platform !== "web") {
							try {
								require.resolve(args.path, { paths: [args.resolveDir] });
								return null; // resolvable locally - inline it
							} catch {
								if (!externalizedMap[pkg]) {
									const version = getInstalledVersion(pkg);
									if (version) externalizedMap[pkg] = version;
								}
								return { path: args.path, external: true };
							}
						}
						return null;
					}

					// Track installed version for the base package
					if (!externalizedMap[pkg]) {
						const version = getInstalledVersion(pkg);
						if (version) externalizedMap[pkg] = version;
					}

					// Bare import: always externalize
					if (args.path === pkg) {
						return { path: pkg, external: true };
					}

					// Subpath import: for version-sensitive packages and platform
					// scoped packages, always externalize to avoid inlining.
					if (alwaysExternalSubpaths.has(pkg) || pkg.startsWith("@react-native/") || pkg.startsWith("@expo/")) {
						return { path: args.path, external: true };
					}

					try {
						require.resolve(args.path, { paths: [args.resolveDir] });
						return null;
					} catch {
						return { path: args.path, external: true };
					}
				});
			},
		};

		const outFile = path.join(tmpDir, "__out.js");
		const isFont = pkgName.startsWith("@expo-google-fonts/");
		const outdir = isFont ? path.join(tmpDir, "__outdir") : undefined;
		await buildTolerant({
			entryPoints: [entryFile],
			bundle: true,
			format: "iife",
			globalName: "__module",
			// For font packages: use outdir so esbuild can emit asset files alongside the JS.
			// For everything else: use outfile as before.
			...(isFont ? { outdir } : { outfile: outFile }),
			...esbuildPlatformSettings(platform),
			// For RN/Expo packages: platform-appropriate extensions, JSX in .js,
			// and serve font assets as static files instead of inlining as data URLs.
			...(isReactNative && {
				...rnEsbuildSettings(platform),
				...(isFont && {
					loader: {
						".js": "jsx",
						".ttf": "file",
						".otf": "file",
						".png": "dataurl",
						".jpg": "dataurl",
						".jpeg": "dataurl",
						".gif": "dataurl",
						".webp": "dataurl",
						".svg": "dataurl",
						".xml": "dataurl",
					},
					publicPath: `${baseUrl || `http://localhost:${PORT}`}/assets`,
					assetNames: "[name]-[hash]",
				}),
			}),
			plugins: [
				...(isReactNative ? rnPluginStack(platform, "pkg") : []),
				selectiveExternalPlugin,
			],
		});

		// For font packages: move asset files to cache/assets/ for static serving,
		// and read the JS output from the outdir.
		if (isFont && outdir) {
			const ASSETS_DIR = path.join(CACHE_DIR, "assets");
			fs.mkdirSync(ASSETS_DIR, { recursive: true });
			const outFiles = fs.readdirSync(outdir);
			for (const f of outFiles) {
				if (!f.endsWith(".js")) {
					// Move font files to cache/assets/
					fs.copyFileSync(path.join(outdir, f), path.join(ASSETS_DIR, f));
				}
			}
			// Copy the JS output to the expected outFile path
			const jsFile = outFiles.find(f => f.endsWith(".js"));
			if (jsFile) {
				fs.copyFileSync(path.join(outdir, jsFile), outFile);
			}
		}

		const bundled = normalizeBuildPaths(
			await lowerClassesForHermes(fs.readFileSync(outFile, "utf-8"), platform),
			tmpDir
		);
		const externalsJson = JSON.stringify(externalizedMap);
		const wrapped = `// Bundled: ${requireSpecifier}@${resolvedVersion}\n// @externals ${externalsJson}\n${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }\n`;

		fs.writeFileSync(finalCacheFile, wrapped);
		fs.writeFileSync(finalExternalsFile, externalsJson);
		console.log(`[cached] ${requireSpecifier}@${resolvedVersion} (externals: ${Object.keys(externalizedMap).length})`);

		res.header("X-Externals", externalsJson);
		res.header("X-Resolved-Version", resolvedVersion);
		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").send(wrapped);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[error] ${requireSpecifier}@${version}:`, message);
		if (!res.headersSent) {
			const safeMessage = message.replace(/[\r\n\t]+/g, " ");
			// no-store: a build failure cached by the CDN (nginx used to add a
			// blanket immutable header) poisons the URL until a manual purge.
			res.header("Cache-Control", "no-store").status(500).send(`// Error bundling ${requireSpecifier}@${version}\n// ${safeMessage}\n`);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ============================================================
// Batch dependency bundling: GET /bundle-deps/:hash, POST /bundle-deps
// ============================================================

const BUNDLE_DEPS_PREFIX = "bundle-deps-";

// depHash -> promise of the currently-running combined build (see POST /bundle-deps).
const inflightBundleBuilds = new Map<string, Promise<void>>();


// ============================================================
// GET /prelude/:rnVersion - metro-runtime require.js for native bundles
//
// The per-module __d emitter needs the REAL metro-runtime module system
// (module.hot machinery, React Refresh integration) as a plain script that
// runs before any __d. metro-runtime ships Flow source, so it goes through
// the same babel preset + Hermes lowering as react-native core. Version is
// derived from react-native's own metro-runtime dependency range so the
// runtime always matches the RN line the app uses.
// ============================================================
app.get("/prelude/:rnVersion", async (req: Request, res: Response) => {
	try {
		let rnVersion = String(req.params.rnVersion);
		// SECURITY: rnVersion flows into npm subprocesses below; reject anything
		// that isn't a valid version/range before it gets there.
		if (!isValidVersionRange(rnVersion)) {
			res.header("Cache-Control", "no-store").status(400).send("// Invalid react-native version\n");
			return;
		}
		if (needsResolution(rnVersion)) {
			rnVersion = (await resolveVersionAsync("react-native", rnVersion)) || rnVersion;
		}
		const cacheFile = path.join(CACHE_DIR, `prelude-${rnVersion.replace(/[^\w.-]/g, "_")}.js`);
		if (fs.existsSync(cacheFile)) {
			console.log(`[prelude cache hit] rn@${rnVersion}`);
			res.header("Cache-Control", "public, max-age=31536000, immutable");
			res.type("application/javascript").sendFile(cacheFile);
			return;
		}

		console.log(`[prelude] building metro-runtime require.js for rn@${rnVersion}`);
		// Which metro-runtime does this RN pin?
		const { stdout } = await execFileAsync(
			"npm",
			["view", `react-native@${rnVersion}`, "dependencies.metro-runtime"],
			{ killSignal: "SIGKILL", timeout: 30000 }
		);
		const range = stdout.trim() || "latest";

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prelude-"));
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "prelude-tmp", version: "1.0.0" }));
			await execFileAsync("npm", ["install", "--ignore-scripts", `metro-runtime@${range}`, "--no-audit", "--no-fund"], {
				cwd: tmpDir,
				killSignal: "SIGKILL",
				timeout: 120000,
				maxBuffer: 16 * 1024 * 1024,
			});
			const requireJs = fs.readFileSync(
				path.join(tmpDir, "node_modules", "metro-runtime", "src", "polyfills", "require.js"),
				"utf8"
			);
			// Flow strip + downlevel exactly like RN core files.
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const babel = require("@babel/core") as typeof import("@babel/core");
			const preset = await babel.transformAsync(requireJs, {
				filename: "require.js",
				presets: [[require.resolve("@react-native/babel-preset"), { enableBabelRuntime: false }]],
				babelrc: false,
				configFile: false,
				compact: false,
				sourceMaps: false,
			});
			if (preset?.code == null) throw new Error("babel produced no output for metro-runtime require.js");
			const lowered = await lowerClassesForHermes(preset.code, "ios");

			const body = `// metro-runtime require.js (rn@${rnVersion}, metro-runtime@${range})\n${lowered}\n`;
			fs.writeFileSync(cacheFile, body);
			res.header("Cache-Control", "public, max-age=31536000, immutable");
			res.type("application/javascript").send(body);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[prelude error]", message.slice(0, 400));
		if (!res.headersSent) res.header("Cache-Control", "no-store").status(500).send(`// Error building prelude\n// ${message.replace(/[\r\n\t]+/g, " ").slice(0, 300)}\n`);
	}
});

// ============================================================
// POST /nativewind-css - compile tailwind CSS to css-interop's native
// runtime data (StyleSheetRegisterCompiledOptions).
//
// Body: { platform, versions: { nativewind, tailwindcss,
//         "react-native-css-interop"? }, tailwindConfig, css,
//         content: { "<path>": "<source>", ... } }
//
// Replicates what nativewind's metro plugin does at bundle time: run
// tailwind over the project sources with NATIVEWIND_OS set (the preset
// branches native/web on it), then cssToReactNativeRuntime() the output.
// The client wraps the returned JSON in an injectData() module for the
// project's `.css` import. Node envs (node_modules installs) are reused
// per version set; results are cached by input hash.
// ============================================================
const NATIVEWIND_RUNNER = `
const path = require("path");
const fs = require("fs");
const workdir = process.argv[2];
const platform = process.argv[3] || "ios";
// The nativewind preset branches native/web on this; must be set BEFORE the
// config (which requires the preset) is loaded.
process.env.NATIVEWIND_OS = platform;
const postcss = require("postcss");
const tailwind = require("tailwindcss");
const { cssToReactNativeRuntime } = require("react-native-css-interop/css-to-rn");
let baseOptions = {};
try {
	baseOptions = require("nativewind/dist/metro/common").cssToReactNativeRuntimeOptions || {};
} catch { /* older nativewind layout; defaults below still apply */ }
const config = require(path.join(workdir, "tailwind.config.js"));
// Content globs from the user's config are project-relative; scan everything
// we materialized instead.
config.content = [path.join(workdir, "**/*.{html,js,jsx,ts,tsx,mdx}")];
const cssSrc = fs.readFileSync(path.join(workdir, "__input.css"), "utf8");
postcss([tailwind(config)])
	.process(cssSrc, { from: path.join(workdir, "__input.css") })
	.then((result) => {
		if (platform === "web") {
			// Web wants the real stylesheet (className hits the DOM via
			// react-native-web + css-interop's web runtime).
			process.stdout.write(JSON.stringify({ web: true, css: result.css }));
			return;
		}
		const data = cssToReactNativeRuntime(result.css, {
			...baseOptions,
			inlineRem: 14,
			selectorPrefix: typeof config.important === "string" ? config.important : undefined,
		});
		process.stdout.write(JSON.stringify(data ?? {}));
	})
	.catch((err) => {
		console.error(err && err.stack ? err.stack : String(err));
		process.exit(1);
	});
`;

app.post("/nativewind-css", async (req: Request, res: Response) => {
	try {
		const body = req.body || {};
		const platform = normalizePlatform(String(body.platform || "ios"));
		const versions: Record<string, string> = body.versions || {};
		const tailwindConfig: string = String(body.tailwindConfig || "");
		const css: string = String(body.css || "");
		const content: Record<string, string> = body.content || {};
		if (!versions.nativewind || !versions.tailwindcss) {
			res.status(400).json({ error: "versions.nativewind and versions.tailwindcss are required" });
			return;
		}
		if (!tailwindConfig || !css) {
			res.status(400).json({ error: "tailwindConfig and css are required" });
			return;
		}

		// NW_COMPILE_VERSION bumps when post-compile transforms change the OUTPUT
		// for unchanged input (the animation degrade below), so old cache entries
		// aren't served with the pre-fix animation data.
		const NW_COMPILE_VERSION = 5;
		const inputHash = crypto
			.createHash("sha256")
			.update(JSON.stringify({ v: NW_COMPILE_VERSION, platform, versions, tailwindConfig, css, content }))
			.digest("hex")
			.slice(0, 16);
		const cacheFile = path.join(CACHE_DIR, `nativewind-${inputHash}.json`);
		if (fs.existsSync(cacheFile)) {
			console.log(`[nativewind cache hit] ${inputHash}`);
			res.header("Cache-Control", "public, max-age=31536000, immutable");
			res.type("application/json").sendFile(cacheFile);
			return;
		}

		// Env dir (installed node_modules) reused across requests per version set.
		const envDeps: Record<string, string> = {
			nativewind: versions.nativewind,
			tailwindcss: versions.tailwindcss,
			postcss: "^8",
		};
		if (versions["react-native-css-interop"]) {
			envDeps["react-native-css-interop"] = versions["react-native-css-interop"];
		}
		// css-interop's css-to-rn reads react-native/package.json (semver
		// feature flags only) -- stub it with the client's RN version instead
		// of installing all of react-native into the env.
		const rnVersion = String(versions["react-native"] || "0.81.0").replace(/^[\^~]/, "");
		const envHash = crypto
			.createHash("sha256")
			.update(JSON.stringify({ envDeps, rnVersion }))
			.digest("hex")
			.slice(0, 12);
		const envDir = path.join(CACHE_DIR, `nativewind-env-${envHash}`);
		if (!fs.existsSync(path.join(envDir, "node_modules", "tailwindcss"))) {
			console.log(`[nativewind] installing env ${envHash} (${JSON.stringify(envDeps)})`);
			fs.mkdirSync(envDir, { recursive: true });
			fs.writeFileSync(
				path.join(envDir, "package.json"),
				JSON.stringify({ name: "nativewind-env", version: "1.0.0", dependencies: envDeps })
			);
			await execFileAsync("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
				cwd: envDir,
				killSignal: "SIGKILL",
				timeout: 180000,
				maxBuffer: 16 * 1024 * 1024,
			});
		}
		const rnStubDir = path.join(envDir, "node_modules", "react-native");
		fs.mkdirSync(rnStubDir, { recursive: true });
		fs.writeFileSync(
			path.join(rnStubDir, "package.json"),
			JSON.stringify({ name: "react-native", version: rnVersion, main: "index.js" })
		);
		fs.writeFileSync(path.join(envDir, "runner.cjs"), NATIVEWIND_RUNNER);

		// Materialize the request's sources in an isolated workdir inside the
		// env (so config requires resolve against the env's node_modules).
		const workdir = fs.mkdtempSync(path.join(envDir, "work-"));
		try {
			fs.writeFileSync(path.join(workdir, "tailwind.config.js"), tailwindConfig);
			fs.writeFileSync(path.join(workdir, "__input.css"), css);
			for (const [rawPath, source] of Object.entries(content)) {
				// VFS paths are absolute-ish ("/app/index.tsx"); flatten safely.
				const rel = rawPath.replace(/^\/+/, "");
				if (rel.includes("..") || typeof source !== "string") continue;
				const dest = path.join(workdir, rel);
				if (!dest.startsWith(workdir + path.sep)) continue;
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.writeFileSync(dest, source);
			}

			const t = Date.now();
			const { stdout } = await execFileAsync(
				"node",
				["runner.cjs", workdir, platform],
				{ cwd: envDir, killSignal: "SIGKILL", timeout: 120000, maxBuffer: 64 * 1024 * 1024 }
			);
			const data = JSON.parse(stdout);
			const degraded = platform !== "web" ? degradeIncompatibleAnimations(data, versions) : 0;
			console.log(
				`[nativewind] compiled ${inputHash} (${platform}) in ${Date.now() - t}ms` +
					(degraded > 0 ? ` (stripped ${degraded} CSS animation/transition rule(s): reanimated 4 + css-interop 0.2.x crashes on the UI runtime)` : "")
			);
			const responseBody = JSON.stringify({ data });
			fs.writeFileSync(cacheFile, responseBody);
			res.header("Cache-Control", "public, max-age=31536000, immutable");
			res.type("application/json").send(responseBody);
		} finally {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[nativewind error]", message.slice(0, 600));
		if (!res.headersSent) {
			res.header("Cache-Control", "no-store").status(500).json({ error: message.slice(0, 500) });
		}
	}
});

// GET /bundle-deps/:hash - serve cached dep bundle (CDN cacheable)
app.get("/bundle-deps/:hash", (req: Request, res: Response) => {
	const hash = req.params.hash;
	const cacheFile = path.join(CACHE_DIR, `${BUNDLE_DEPS_PREFIX}${hash}.js`);

	if (fs.existsSync(cacheFile)) {
		console.log(`[bundle-deps cache hit] ${hash}`);
		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").sendFile(cacheFile);
		return;
	}

	// no-store: Cloudflare negative-caches plain 404s (~5 min), which blocks
	// the GET path for freshly-built hashes and every client's first warm run.
	//
	// X-Build-Status lets a polling client tell "still building, keep waiting"
	// apart from "nobody is building this, stop waiting". Without it the client
	// has to guess a timeout, and guessing wrong abandons a build that was
	// nearly done (observed in production: a 746s build abandoned by a 600s
	// client budget, which then fell back to per-package fetches).
	const building = inflightBundleBuilds.has(String(hash));
	res
		.header("Cache-Control", "no-store")
		.header("X-Build-Status", building ? "building" : "absent")
		.status(404)
		.send(building ? "// Building\n" : "// Not found\n");
});

// POST /bundle-deps - build a dep bundle
app.post("/bundle-deps", async (req: Request, res: Response) => {
	const { hash, dependencies, subpaths: rawSubpaths, platform: rawPlatform } = req.body as { hash?: string; dependencies: Record<string, string>; subpaths?: string[]; platform?: string };

	// Test affordances, honoured ONLY for loopback callers: a public
	// cache-bypass switch would let anyone force expensive rebuilds.
	const fromLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip ?? "");
	const bypassChunkCache = fromLoopback && req.header("x-esm-no-chunk-cache") === "1";
	const forceRebuild = fromLoopback && req.header("x-esm-fresh") === "1";

	if (!dependencies || typeof dependencies !== "object") {
		res.header("Cache-Control", "no-store").status(400).send("// Missing dependencies\n");
		return;
	}

	// SECURITY: dependency names/versions come straight from the POST body and
	// are passed to `bun install`/`npm install`. execFile (argv array) already
	// prevents shell injection; validating here additionally rejects npm-flag
	// injection (a name/version starting with `-`), path-traversal names, and
	// junk that would only waste an install attempt.
	for (const [name, ver] of Object.entries(dependencies)) {
		if (!isValidPackageName(name) || !isValidVersionRange(ver)) {
			res.header("Cache-Control", "no-store").status(400).send("// Invalid dependency name or version\n");
			return;
		}
	}

	// Absent/unknown platform is "web" -- byte-identical to the platform-less
	// protocol, so existing clients and cached hashes are unaffected.
	const platform = normalizePlatform(rawPlatform);

	// Subpaths of direct deps that user code imports (e.g. "expo-router/drawer").
	// We bundle these combined with their base package so they share the base's
	// private internals (one CurrentRouteContext, one router store) instead of
	// each subpath re-bundling a duplicate copy. See the combined-build logic
	// below and collectUsedSubpaths in browser-metro.
	// SECURITY: subpaths are interpolated into generated `require("<sub>")` entry
	// files; restrict to a safe package-subpath charset so a crafted value can't
	// break out of the string literal (code injection into a served bundle) or
	// traverse the filesystem. Legit subpaths (expo-router/drawer,
	// @react-navigation/native, react-dom/client) all match.
	const SUBPATH_RE = /^[a-zA-Z0-9@][a-zA-Z0-9@/._-]*$/;
	const requestedSubpaths = Array.isArray(rawSubpaths)
		? rawSubpaths.filter((s): s is string => typeof s === "string" && !s.includes("..") && SUBPATH_RE.test(s))
		: [];

	// Compute hash if not provided
	const depHash = hash || hashDepsServer(dependencies, requestedSubpaths, platform);
	const cacheFile = path.join(CACHE_DIR, `${BUNDLE_DEPS_PREFIX}${depHash}.js`);

	// Check cache
	if (fs.existsSync(cacheFile) && !forceRebuild) {
		console.log(`[bundle-deps cache hit] ${depHash}`);
		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").sendFile(cacheFile);
		return;
	}

	// In-flight dedup: a client retrying its POST (CDN 504, network blip) must
	// join the running build for this hash, not spawn a duplicate ~3-minute
	// build that doubles server load.
	const inflight = inflightBundleBuilds.get(depHash);
	if (inflight) {
		console.log(`[bundle-deps] joining in-flight build (hash: ${depHash})`);
		try {
			await inflight;
		} catch {
			/* the original build failed; fall through to the cache check */
		}
		if (fs.existsSync(cacheFile)) {
			res.header("Cache-Control", "public, max-age=31536000, immutable");
			res.type("application/javascript").sendFile(cacheFile);
		} else {
			res.header("Cache-Control", "no-store").status(500).json({ error: "bundle build failed (in-flight)" });
		}
		return;
	}
	let resolveInflight!: () => void;
	let rejectInflight!: (err: unknown) => void;
	const inflightPromise = new Promise<void>((res2, rej2) => {
		resolveInflight = res2;
		rejectInflight = rej2;
	});
	inflightPromise.catch(() => {}); // observed by joiners; avoid unhandled rejection
	inflightBundleBuilds.set(depHash, inflightPromise);

	console.log(`[bundle-deps] Building for ${Object.keys(dependencies).length} deps (hash: ${depHash})`);
	const buildStart = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-deps-"));

	try {
		// Install ALL deps in one go (bun install — ~6-7x faster than npm)
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "bundle-deps-tmp", version: "1.0.0" }));
		const installStart = Date.now();

		// bun install is all-or-nothing — one unsatisfiable version range fails
		// the entire batch. We retry with offending packages dropped so the rest
		// of the deps still install. Dropped packages get a `module.exports = {}`
		// stub later so `require()` doesn't crash at runtime (the offending dep
		// just silently no-ops, same as a missing import).
		const droppedPackages = new Set<string>();
		let workingDeps: Record<string, string> = { ...dependencies };
		const MAX_RETRIES = 3;
		let installed = false;
		for (let attempt = 0; attempt < MAX_RETRIES && !installed; attempt++) {
			// argv array, not a shell string: each `name@ver` is one literal
			// argument, so a metacharacter in a dependency name/version (POST body)
			// cannot inject a command.
			const specs = Object.entries(workingDeps).map(([n, v]) => `${n}@${v}`);
			try {
				await execFileAsync("bun", ["install", "--no-progress", "--ignore-scripts", ...specs], {
					cwd: tmpDir,
					// The common dep set (expo/react-native/nativewind/supabase +
					// the @expo-google-fonts family and other recurring extras) is
					// pre-warmed into bun's global cache at deploy — see
					// scripts/prewarm-bun-cache.mjs. With that warm, an honest
					// install of the shared closure is seconds, so an install still
					// running past this bound is a genuine stall (bun intermittently
					// hangs under piped spawn), not honest downloading. Fail fast to
					// the npm fallback rather than burning the old 300s here; a truly
					// novel package outside the pre-warm set that needs longer is
					// caught by npm's more generous timeout below.
					killSignal: "SIGKILL",
			timeout: BUN_INSTALL_TIMEOUT_MS,
					maxBuffer: 16 * 1024 * 1024,
				});
				installed = true;
				console.log(
					`[bundle-deps] bun install completed in ${Date.now() - installStart}ms` +
					(droppedPackages.size > 0 ? ` (dropped: ${[...droppedPackages].join(", ")})` : "")
				);
			} catch (installErr: unknown) {
				const e = installErr as { stderr?: Buffer; stdout?: Buffer; message?: string };
				const stderr = e.stderr?.toString() || "";
				const stdout = e.stdout?.toString() || "";

				// Parse bun's "No version matching ... found for specifier ..."
				// lines and remove those packages, then retry.
				const unsatisfiable = new Set<string>();
				const re = /No version matching "[^"]+" found for specifier "([^"]+)"/g;
				let m: RegExpExecArray | null;
				while ((m = re.exec(stderr)) !== null) unsatisfiable.add(m[1]);

				const removed: string[] = [];
				for (const name of unsatisfiable) {
					if (name in workingDeps) {
						removed.push(`${name}@${workingDeps[name]}`);
						delete workingDeps[name];
						droppedPackages.add(name);
					}
				}

				// bun install intermittently hangs under piped spawn (observed on
				// macOS with a large bun cache, and on the origin as multi-minute
				// SIGKILL timeouts). A second bun attempt rarely un-hangs and just
				// doubled the wait, so on the FIRST timeout we fall straight over to
				// npm — slower but it has never hung in this server's /pkg path.
				// exec's timeout surfaces as killed:true + SIGTERM rather than ETIMEDOUT.
				const timedOut =
					(e as { code?: string }).code === "ETIMEDOUT" ||
					/ETIMEDOUT/.test(e.message || "") ||
					(e as { killed?: boolean }).killed === true;
				if (removed.length === 0 && timedOut && attempt < MAX_RETRIES - 1) {
					console.warn(`[bundle-deps] bun install timed out (${BUN_INSTALL_TIMEOUT_MS}ms) — falling back to npm install`);
					try {
						const npmSpecs = Object.entries(workingDeps).map(([n, v]) => `${n}@${v}`);
						await execFileAsync("npm", ["install", "--ignore-scripts", ...npmSpecs, "--legacy-peer-deps", "--no-audit", "--no-fund"], {
							cwd: tmpDir,
							killSignal: "SIGKILL",
							timeout: 420000,
							maxBuffer: 16 * 1024 * 1024,
						});
						installed = true;
						console.log(`[bundle-deps] npm fallback completed in ${Date.now() - installStart}ms (total incl. bun attempts)`);
						continue;
					} catch (npmErr: unknown) {
						const ne = npmErr as { message?: string };
						console.error(`[bundle-deps] npm fallback also failed: ${ne.message?.slice(0, 200)}`);
						// fall through to the hard-failure path below
					}
				}

				if (removed.length === 0) {
					// No recoverable cause — surface the original error
					console.error(`[bundle-deps install FAILED in ${Date.now() - installStart}ms] tmpDir=${tmpDir}`);
					console.error(`[bundle-deps install stderr]\n${stderr}`);
					console.error(`[bundle-deps install stdout]\n${stdout}`);
					throw new Error(
						`bun install failed: ${e.message || "unknown"}\n---STDERR---\n${stderr.slice(-4000)}`
					);
				}

				console.warn(
					`[bundle-deps] attempt ${attempt + 1}: bun rejected ${removed.length} unsatisfiable spec(s) — retrying without them: ${removed.join(", ")}`
				);
			}
		}
		if (!installed) {
			throw new Error(`bun install failed after ${MAX_RETRIES} retries`);
		}

		// Discover all packages to bundle: direct deps + their transitive deps
		const allPackages = new Map<string, { version: string; isRN: boolean }>();
		const nodeModules = path.join(tmpDir, "node_modules");

		function discoverPackages(pkgName: string, visited: Set<string>) {
			if (visited.has(pkgName)) return;
			visited.add(pkgName);

			const pkgJsonPath = path.join(nodeModules, pkgName, "package.json");
			if (!fs.existsSync(pkgJsonPath)) return;

			const meta = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
			const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
			const isRN = pkgName.startsWith("@expo/") ||
				pkgName.startsWith("@expo-google-fonts/") ||
				pkgName.includes("react-native") ||
				keywords.some((k: string) => k === "react-native" || k === "expo");

			allPackages.set(pkgName, { version: meta.version, isRN });

			// Recurse into deps
			const deps = Object.keys(meta.dependencies || {});
			const peerDeps = Object.keys(meta.peerDependencies || {});
			for (const dep of [...deps, ...peerDeps]) {
				discoverPackages(dep, visited);
			}
		}

		const visited = new Set<string>();
		for (const name of Object.keys(dependencies)) {
			discoverPackages(name, visited);
		}

		// Only bundle the user's direct dependencies as separate entries.
		// Transitive deps get inlined into their consumers. This avoids
		// CJS/ESM interop issues with small utility packages.
		const directDeps = new Set(Object.keys(dependencies));
		for (const name of allPackages.keys()) {
			if (!directDeps.has(name)) {
				allPackages.delete(name);
			}
		}

		// Add known subpath entry points for direct deps that are commonly imported
		const knownSubpaths: Record<string, string[]> = {
			"react-dom": ["react-dom/client", "react-dom/server"],
			"react": ["react/jsx-runtime", "react/jsx-dev-runtime"],
		};
		for (const [pkg, subpaths] of Object.entries(knownSubpaths)) {
			if (directDeps.has(pkg)) {
				for (const sub of subpaths) {
					const subPkgPath = path.join(nodeModules, ...sub.split("/"));
					// Check if the subpath actually exists
					try {
						require.resolve(sub, { paths: [tmpDir] });
						allPackages.set(sub, { version: allPackages.get(pkg)?.version || "unknown", isRN: false });
					} catch {}
				}
			}
		}

		// Also scan all bundled code for subpath requires of direct deps and add them
		// This is done AFTER initial bundling in the subpath scanning section below

		console.log(`[bundle-deps] Bundling ${allPackages.size} entries (direct deps + subpaths)...`);

		// Only externalize other direct deps (they're separate entries in the batch)
		// Plus known platform modules
		const batchSet = new Set(allPackages.keys());
		for (const implicit of ["react-native", "react", "react-dom", "expo", "expo-modules-core"]) {
			batchSet.add(implicit);
		}
		// Native: the assets registry must be a shared singleton across the
		// batch (app asset modules and RN's resolveAssetSource read the same
		// instance), so externalize it everywhere; the client fetches it once.
		if (platform !== "web") {
			batchSet.add("@react-native/assets-registry");
		}

		// Build the manifest (name -> resolved version)
		const manifest: Record<string, string> = {};
		for (const [name, info] of allPackages) {
			manifest[name] = info.version;
		}

		// Group user-imported subpaths by their base direct-dep package. A base
		// with subpaths is built ONCE as a combined esbuild entry (base + its
		// subpaths) so they share the base's private internal modules — fixing
		// the duplicate-CurrentRouteContext "No filename found" bug for
		// expo-router/drawer et al. Only subpaths whose base is a bundled direct
		// dep and that aren't already their own batch entry qualify; the rest
		// fall through to the standalone subpath pass / runtime /pkg fetch.
		const sharedSubpathsByBase = new Map<string, string[]>();
		for (const sub of requestedSubpaths) {
			let base: string;
			if (sub.startsWith("@")) {
				const parts = sub.split("/");
				if (parts.length < 3) continue;
				base = parts.slice(0, 2).join("/");
			} else {
				const slash = sub.indexOf("/");
				if (slash === -1) continue;
				base = sub.slice(0, slash);
			}
			if (base === sub || !allPackages.has(base) || allPackages.has(sub)) continue;
			try { require.resolve(sub, { paths: [tmpDir] }); } catch { continue; }
			const list = sharedSubpathsByBase.get(base) ?? [];
			if (!list.includes(sub)) list.push(sub);
			sharedSubpathsByBase.set(base, list);
		}
		// Subpaths emitted as combined stubs — skip them in the standalone pass.
		const emittedSubpaths = new Set<string>();

		// Bundle each package
		const chunks: string[] = [];
		const errors: string[] = [];
		const phase = { pkgLoop: 0, subpathLoop: 0, assemble: 0 };
		const tPkgLoop = Date.now();

		// Flow stripping / platform filtering / node stubs come from the hoisted
		// platform-aware plugin stack (rnPluginStack).

		// ── Per-package chunk cache ────────────────────────────────────────────
		//
		// A combined bundle is a concatenation of independently-built per-package
		// chunks, and measurement on production showed 95% of those builds to be
		// exact repeats (126 distinct package@version across 2,543 build slots in
		// the 40 most recent dep sets; median 78% set overlap). Caching chunks
		// turns "add one dependency" from a full rebuild into one chunk.
		//
		// The key must capture everything that changes a chunk's bytes. Measured
		// (see chunk-experiment): that is package@version, platform, nv, the
		// subpaths folded in, and the EXTERNALS DECISION -- a package inlines a
		// dependency that isn't a direct dep of the requested set, and
		// externalizes it when it is. Rather than change that rule (which would
		// break nested version conflicts: P declaring lodash@3 while the app
		// pins lodash@4 must keep inlining its own copy), the key includes the
		// batch-set names this package could externalize. Adding a dependency
		// nothing declares -- the common case -- leaves every key untouched.
		const chunkCacheDir = path.join(CACHE_DIR, "chunks");
		const chunkStats = { hit: 0, built: 0 };
		const declaredDepsOf = (pkgName: string): string[] => {
			try {
				const pj = JSON.parse(
					fs.readFileSync(path.join(tmpDir, "node_modules", pkgName, "package.json"), "utf8")
				);
				return Object.keys({ ...(pj.dependencies ?? {}), ...(pj.peerDependencies ?? {}) }).sort();
			} catch {
				return [];
			}
		};
		const chunkKeyFor = (pkgName: string, version: string, subs: string[]): string => {
			// Only batch members that this package might import can affect its
			// externals, so the key stays stable when unrelated deps come and go.
			const relevant = declaredDepsOf(pkgName).filter((d) => batchSet.has(d));
			const input = JSON.stringify({
				pkg: pkgName,
				version,
				platform,
				nv: NATIVE_DEPS_VERSION,
				subs: [...subs].sort(),
				externals: relevant,
			});
			return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
		};
		const readChunk = (key: string): string | null => {
			if (process.env.ESM_NO_CHUNK_CACHE || bypassChunkCache) return null;
			try {
				return fs.readFileSync(path.join(chunkCacheDir, `${key}.js`), "utf8");
			} catch {
				return null;
			}
		};
		const writeChunk = (key: string, body: string): void => {
			if (process.env.ESM_NO_CHUNK_CACHE || bypassChunkCache) return;
			try {
				fs.mkdirSync(chunkCacheDir, { recursive: true });
				fs.writeFileSync(path.join(chunkCacheDir, `${key}.js`), body);
			} catch {
				/* cache write failure is non-fatal */
			}
		};

		for (const [pkgName, info] of allPackages) {
			// Build-time-only tooling (tailwindcss/postcss/...) is never required
			// at client runtime and cannot bundle for a browser/Hermes target;
			// stub it directly instead of paying an esbuild attempt that is
			// guaranteed to fail into the same stub below. Same end state, no spew.
			if (CLIENT_EXCLUDED_BUILD_TOOLS.has(pkgName)) {
				chunks.push(`// @dep-start ${pkgName}\n// build-time tooling, stubbed on client\nmodule.exports = {};\n// @dep-end ${pkgName}`);
				continue;
			}
			const subs = sharedSubpathsByBase.get(pkgName) ?? [];
			// Cached chunk for this exact (package, version, platform, nv, subpaths,
			// externals) combination? Then skip esbuild entirely.
			const chunkKey = chunkKeyFor(pkgName, info.version, subs);
			const cachedChunk = readChunk(chunkKey);
			if (cachedChunk !== null) {
				chunks.push(cachedChunk);
				chunkStats.hit++;
				if (subs.length > 0) {
					for (const sub of subs) {
						const stub = `module.exports = (require(${JSON.stringify(pkgName)}), (globalThis.__rnSubpaths || {})[${JSON.stringify(sub)}]);`;
						chunks.push(`// @dep-start ${sub}\n${stub}\n// @dep-end ${sub}`);
						manifest[sub] = info.version;
						emittedSubpaths.add(sub);
					}
				}
				continue;
			}
			try {
				const entryFile = path.join(tmpDir, `__entry_${pkgName.replace(/\//g, "__")}.js`);
				const outFile = path.join(tmpDir, `__out_${pkgName.replace(/\//g, "__")}.js`);
				// Combined entry stashes each subpath's exports on a global registry
				// so the per-subpath stub (emitted below) reads the SAME instance
				// the base built. The subpaths (pkgName + "/...") stay internal to
				// this esbuild run via pkgExternalPlugin, so internals are shared.
				const writeEntry = (withSubs: boolean) => {
					if (withSubs && subs.length) {
						const lines = [
							`var __rn = (globalThis.__rnSubpaths = globalThis.__rnSubpaths || {});`,
							...subs.map((s) => `__rn[${JSON.stringify(s)}] = require(${JSON.stringify(s)});`),
							`module.exports = require(${JSON.stringify(pkgName)});`,
						];
						fs.writeFileSync(entryFile, lines.join("\n") + "\n");
					} else {
						fs.writeFileSync(entryFile, `module.exports = require("${pkgName}");\n`);
					}
				};
				writeEntry(true);

				// Create selective external plugin for this package
				const pkgExternalPlugin: esbuild.Plugin = {
					name: "batch-external",
					setup(build) {
						build.onResolve({ filter: /^[^./]/ }, (args) => {
							let dep: string;
							if (args.path.startsWith("@")) {
								const parts = args.path.split("/");
								dep = parts.length >= 2 ? parts.slice(0, 2).join("/") : args.path;
							} else {
								dep = args.path.split("/")[0];
							}

							// Don't externalize from self (handles both base package and subpath entries)
							if (dep === pkgName) return null;
							if (args.path === pkgName || args.path.startsWith(pkgName + "/")) return null;

							// Only externalize other direct deps in the batch.
							// Transitive deps are inlined into their consumers.
							if (batchSet.has(dep)) {
								return { path: args.path, external: true };
							}

							// For RN packages, externalize @react-native/* and @expo/* if unresolvable
							if (info.isRN && (dep.startsWith("@react-native/") || dep.startsWith("@expo/"))) {
								try {
									require.resolve(args.path, { paths: [args.resolveDir] });
									return null;
								} catch {
									return { path: args.path, external: true };
								}
							}

							// NATIVE Metro leniency: an unresolvable bare import (usually an
							// optional peer like react-native-screens when the app forgot to
							// declare it) must not fail the WHOLE chunk. Externalize it -- the
							// client fetches it as its own module at runtime.
							if (platform !== "web") {
								try {
									require.resolve(args.path, { paths: [args.resolveDir] });
									return null;
								} catch {
									console.warn(`[bundle-deps] ${pkgName}: externalizing unresolvable "${args.path}" (native leniency)`);
									return { path: args.path, external: true };
								}
							}

							return null;
						});
					},
				};

				const runBuild = () => buildTolerant({
					entryPoints: [entryFile],
					bundle: true,
					format: "iife",
					globalName: "__module",
					outfile: outFile,
					...esbuildPlatformSettings(platform),
					...(info.isRN && rnEsbuildSettings(platform)),
					plugins: [
						...(info.isRN ? rnPluginStack(platform) : []),
						pkgExternalPlugin,
					],
					logLevel: "silent",
				});

				// If the combined build fails, fall back to base-only so the base
				// package still works (subpaths then resolve via /pkg fetches).
				let emitStubs = subs.length > 0;
				try {
					await runBuild();
				} catch (combinedErr: unknown) {
					if (subs.length === 0) throw combinedErr;
					const m = combinedErr instanceof Error ? combinedErr.message : String(combinedErr);
					console.warn(`[bundle-deps] combined build for ${pkgName} (+${subs.length} subpath(s)) failed, retrying base-only: ${m.slice(0, 160)}`);
					writeEntry(false);
					emitStubs = false;
					await runBuild();
				}

				const bundled = normalizeBuildPaths(
					await lowerClassesForHermes(fs.readFileSync(outFile, "utf-8"), platform),
					tmpDir
				);
				const wrapped = `${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }`;
				const chunkBody = `// @dep-start ${pkgName}\n${wrapped}\n// @dep-end ${pkgName}`;
				chunks.push(chunkBody);
				chunkStats.built++;
				// emitStubs false means the combined build fell back to base-only,
				// whose bytes don't match what this key promises -- don't cache it.
				if (emitStubs || subs.length === 0) writeChunk(chunkKey, chunkBody);

				// Emit a tiny stub chunk per combined subpath. It forces the base
				// chunk to evaluate (populating the registry) then returns the
				// subpath's exports — backed by the base's shared internals.
				if (emitStubs) {
					for (const sub of subs) {
						const stub = `module.exports = (require(${JSON.stringify(pkgName)}), (globalThis.__rnSubpaths || {})[${JSON.stringify(sub)}]);`;
						chunks.push(`// @dep-start ${sub}\n${stub}\n// @dep-end ${sub}`);
						manifest[sub] = info.version;
						emittedSubpaths.add(sub);
					}
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${pkgName}: ${msg}`);
				console.error(`[bundle-deps] Error bundling ${pkgName}:`, msg.slice(0, 2000));
				// Add a stub so require() doesn't fail. Collapse whitespace/newlines —
				// a multi-line esbuild error after a single `//` leaves later lines as
				// live JS (e.g. a relative path starting with `.` → SyntaxError that
				// breaks the whole bundle).
				const safeMsg = msg.replace(/[\r\n\t]+/g, " ").slice(0, 200);
				chunks.push(`// @dep-start ${pkgName}\n// Error bundling: ${safeMsg}\nmodule.exports = {};\n// @dep-end ${pkgName}`);
			}
		}

		phase.pkgLoop = Date.now() - tPkgLoop;
		const tSubLoop = Date.now();

		// Now scan all chunks for subpath requires that need separate entries
		const allCode = chunks.join("\n");
		const subpathRequires = new Set<string>();
		const requireRe = /require\s*\(\s*["']([^"']+\/[^"']+)["']\s*\)/g;
		let m: RegExpExecArray | null;
		while ((m = requireRe.exec(allCode)) !== null) {
			const req = m[1];
			// Only handle subpath of packages in our batch (e.g. react-dom/client)
			let basePkg: string;
			if (req.startsWith("@")) {
				const parts = req.split("/");
				basePkg = parts.slice(0, 2).join("/");
			} else {
				basePkg = req.split("/")[0];
			}
			if (batchSet.has(basePkg) && req !== basePkg && !allPackages.has(req) && !emittedSubpaths.has(req)) {
				subpathRequires.add(req);
			}
		}

		// Bundle subpath variants. Same caching as the package loop: these are
		// independently-built chunks too, and they dominated warm requests
		// (measured 38s of a 42s request once package chunks were cached).
		for (const subpath of subpathRequires) {
			const subBase = subpath.startsWith("@")
				? subpath.split("/").slice(0, 2).join("/")
				: subpath.split("/")[0];
			const subVersion = allPackages.get(subBase)?.version ?? "unknown";
			const subChunkKey = chunkKeyFor(subpath, subVersion, []);
			const cachedSub = readChunk(subChunkKey);
			if (cachedSub !== null) {
				chunks.push(cachedSub);
				chunkStats.hit++;
				continue;
			}
			try {
				const safeName = subpath.replace(/\//g, "__");
				const entryFile = path.join(tmpDir, `__entry_${safeName}.js`);
				const outFile = path.join(tmpDir, `__out_${safeName}.js`);
				fs.writeFileSync(entryFile, `module.exports = require("${subpath}");\n`);

				let basePkg: string;
				if (subpath.startsWith("@")) {
					const parts = subpath.split("/");
					basePkg = parts.slice(0, 2).join("/");
				} else {
					basePkg = subpath.split("/")[0];
				}
				const info = allPackages.get(basePkg);

				const subExternalPlugin: esbuild.Plugin = {
					name: "batch-sub-external",
					setup(build) {
						build.onResolve({ filter: /^[^./]/ }, (args) => {
							// Don't externalize the subpath we're bundling
							if (args.path === subpath || args.path.startsWith(subpath + "/")) return null;

							let dep: string;
							if (args.path.startsWith("@")) {
								const parts = args.path.split("/");
								dep = parts.length >= 2 ? parts.slice(0, 2).join("/") : args.path;
							} else {
								dep = args.path.split("/")[0];
							}

							// Don't externalize the base package of this subpath
							if (dep === basePkg) return null;

							if (batchSet.has(dep)) {
								return { path: args.path, external: true };
							}
							return null;
						});
					},
				};

				await buildTolerant({
					entryPoints: [entryFile],
					bundle: true,
					format: "iife",
					globalName: "__module",
					outfile: outFile,
					...esbuildPlatformSettings(platform),
					...(info?.isRN && rnEsbuildSettings(platform)),
					plugins: [
						...(info?.isRN ? rnPluginStack(platform) : []),
						subExternalPlugin,
					],
					logLevel: "silent",
				});

				const bundled = normalizeBuildPaths(
					await lowerClassesForHermes(fs.readFileSync(outFile, "utf-8"), platform),
					tmpDir
				);
				const wrapped = `${bundled}\nif (typeof __module !== "undefined") { module.exports = __module; }`;
				const subChunkBody = `// @dep-start ${subpath}\n${wrapped}\n// @dep-end ${subpath}`;
				chunks.push(subChunkBody);
				chunkStats.built++;
				writeChunk(subChunkKey, subChunkBody);
			} catch {
				chunks.push(`// @dep-start ${subpath}\nmodule.exports = {};\n// @dep-end ${subpath}`);
			}
		}

		phase.subpathLoop = Date.now() - tSubLoop;
		const tAssemble = Date.now();

		// Emit stubs for packages dropped during install (unsatisfiable version
		// ranges). Runtime `require("<name>")` returns {} instead of crashing.
		for (const name of droppedPackages) {
			chunks.push(
				`// @dep-start ${name}\n// Dropped: install spec unsatisfiable\nmodule.exports = {};\n// @dep-end ${name}`
			);
			manifest[name] = "stub";
		}

		// Assemble final bundle
		const header = `// @dep-bundle ${depHash}\n// @dep-manifest ${JSON.stringify(manifest)}\n// @dep-count ${chunks.length}\n`;
		const bundle = header + chunks.join("\n") + "\n";

		// Cache
		fs.writeFileSync(cacheFile, bundle);
		phase.assemble = Date.now() - tAssemble;
		console.log(`[bundle-deps] Cached ${chunks.length} packages (hash: ${depHash}, size: ${(bundle.length / 1024).toFixed(0)}KB, total: ${Date.now() - buildStart}ms, chunks: ${chunkStats.hit} reused / ${chunkStats.built} built, phases: pkg=${phase.pkgLoop}ms subpath=${phase.subpathLoop}ms assemble=${phase.assemble}ms)`);

		res.header("Cache-Control", "public, max-age=31536000, immutable");
		res.type("application/javascript").send(bundle);
		resolveInflight();
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[bundle-deps error]`, message);
		if (!res.headersSent) {
			res.header("Cache-Control", "no-store").status(500).json({ error: message });
		}
		rejectInflight(err);
	} finally {
		inflightBundleBuilds.delete(depHash);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================
// Individual package endpoint (backward compatible)
// ============================================================

// Serve font asset files (cache/assets/*.ttf, *.otf)
app.use("/assets", express.static(path.join(CACHE_DIR, "assets"), {
	maxAge: "1y",
	immutable: true,
}));

// GET /pkg/* - unpkg-style URLs:
//   /pkg/lodash           -> lodash@latest
//   /pkg/lodash@4.17.21   -> lodash@4.17.21
//   /pkg/react-dom/client -> react-dom@latest, require("react-dom/client")
//   /pkg/react-dom@19/client -> react-dom@19, require("react-dom/client")
//   /pkg/@scope/name@1.0/sub -> @scope/name@1.0, require("@scope/name/sub")
app.use((req: Request, res: Response, next: NextFunction) => {
	if (req.method !== "GET" || !req.path.startsWith("/pkg/")) { next(); return; }
	const raw = decodeURIComponent(req.path.slice("/pkg/".length));
	if (!raw) { next(); return; }

	const parsed = parseSpecifier(raw);
	if (!parsed) { res.header("Cache-Control", "no-store").status(400).send("// Invalid package specifier\n"); return; }

	const baseUrl = `${req.protocol}://${req.get("host")}`;
	const platform = normalizePlatform(req.query.platform);
	handlePkgRequest(res, parsed.pkgName, parsed.version, parsed.subpath, baseUrl, platform).catch(
		(err) => {
			console.error("[unhandled]", err);
			if (!res.headersSent) res.header("Cache-Control", "no-store").status(500).send("// Internal error\n");
		}
	);
});

// Cache retention: opt-in so a deploy never starts deleting unannounced.
// ESM_RETENTION=on enables eviction; ESM_RETENTION=dry reports only.
const retentionMode = process.env.ESM_RETENTION;
if (retentionMode === "on" || retentionMode === "dry") {
	const dryRun = retentionMode === "dry";
	const everyMs = Number(process.env.ESM_RETENTION_INTERVAL_MIN ?? 60) * 60_000;
	const run = () => {
		try {
			console.log(`[retention] sweep start (${dryRun ? "dry run" : "evicting"})`);
			sweepCache(CACHE_DIR, { dryRun });
		} catch (err) {
			console.error("[retention] sweep failed:", err instanceof Error ? err.message : String(err));
		}
	};
	// Not at t=0: let the process finish starting and serve first.
	setTimeout(run, 5 * 60_000).unref();
	setInterval(run, everyMs).unref();
	console.log(`[retention] enabled (${dryRun ? "dry run" : "evicting"}), sweeping every ${everyMs / 60000}min`);
}

// SECURITY: bind loopback ONLY. This server sits behind nginx (which proxies
// from 127.0.0.1) + Cloudflare; listening on 0.0.0.0 exposed :5200 to the
// public internet, letting an attacker reach the app directly and bypass the
// nginx WAF/rate limiting entirely. There is a host firewall too, but binding
// loopback makes the exposure impossible regardless of firewall state.
const BIND_HOST = process.env.ESM_BIND_HOST || "127.0.0.1";
app.listen(PORT, BIND_HOST, () => {
	console.log(`Package server running at http://${BIND_HOST}:${PORT}`);
});
