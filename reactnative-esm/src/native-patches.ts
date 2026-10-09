import * as fs from "fs";
import type esbuild from "esbuild";
import type { BuildPlatform } from "./platform";

/**
 * Upstream bugs patched in NATIVE builds only; web output stays byte-identical.
 *
 * A patch here is applied in two places. The worklets pass claims every file that looks like it
 * animates and reads the source itself, and esbuild stops at the first onLoad that returns
 * contents, so a patch registered after it would never see those files. The worklets pass runs
 * patchNativeSource before babel; makeNativePatchesPlugin, registered after it, covers the files
 * the worklets pass leaves alone (no reanimated in the build root, or a failed transform).
 */
interface NativePatch {
	name: string;
	file: RegExp;
	/** The patched source, or null when the anchor is missing (the file then ships unpatched). */
	apply(source: string): string | null;
}

/**
 * react-native-css-interop's dev-only upgrade warning crashes the screen it is warning about.
 *
 * When a className starts setting a CSS variable, an animation or a container after the first
 * render (a selected state that adds shadow-sm is enough), css-interop remounts the component and
 * logs why, printing its props through a serializer that reads every enumerable property it can
 * reach. Props hold React elements, an element's _owner is its fiber, and from the fiber tree the
 * walk reaches React Navigation's NavigationStateContext, whose default value throws "Couldn't
 * find a navigation context" from its getters by design. A log line became a red screen that
 * blames navigation. nativewind/nativewind#1812: unchanged through 0.2.7, same code in 0.1.x.
 *
 * Upstream's stringify is renamed and left unused (esbuild drops it from the output, so to verify a
 * served bundle grep for "props could not be printed"). The one inserted before it prints elements as
 * `<Name />` instead of walking them, reads each property under try/catch, visits each object once
 * (upstream forgets an object on the way back out, so a shared one is walked once per path to it),
 * and falls back to a placeholder if anything still throws. The warning still prints and the
 * component still remounts; only the crash is gone.
 */
export const SAFE_STRINGIFY = `function stringify(object) {
  var seen = new WeakSet();
  var nameOf = function (type) {
    var name = typeof type === "string" ? type : type && (type.displayName || type.name);
    return typeof name === "string" && name ? name : "Component";
  };
  try {
    return JSON.stringify(object, function (_key, value) {
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (typeof value.$$typeof === "symbol") return "<" + nameOf(value.type) + " />";
      if ("_isReanimatedSharedValue" in value) return "[animated value]";
      var copy = Array.isArray(value) ? [] : {};
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        try {
          copy[keys[i]] = value[keys[i]];
        } catch (_error) {
          copy[keys[i]] = "[unreadable]";
        }
      }
      return copy;
    }, 2);
  } catch (_error) {
    return "[props could not be printed]";
  }
}`;

const STRINGIFY_DECLARATION = "function stringify(object) {";

const cssInteropUpgradeWarning: NativePatch = {
	name: "css-interop upgrade-warning serializer",
	file: /react-native-css-interop[/\\]dist[/\\]runtime[/\\]native[/\\]render-component\.js$/,
	apply(source) {
		const at = source.indexOf(STRINGIFY_DECLARATION);
		if (at === -1 || source.indexOf(STRINGIFY_DECLARATION, at + 1) !== -1) return null;
		if (!source.includes("stringify(originalProps)")) return null;
		return (
			source.slice(0, at) +
			SAFE_STRINGIFY +
			"\nfunction stringifyUnpatched(object) {" +
			source.slice(at + STRINGIFY_DECLARATION.length)
		);
	},
};

const NATIVE_PATCHES: NativePatch[] = [cssInteropUpgradeWarning];

/** Apply every native patch whose file matches. Returns the source unchanged when none does. */
export function patchNativeSource(filePath: string, source: string): string {
	for (const patch of NATIVE_PATCHES) {
		if (!patch.file.test(filePath)) continue;
		const patched = patch.apply(source);
		if (patched === null) {
			console.warn(`[native-patches] ${patch.name} did not apply (anchor missing): ${filePath}`);
			continue;
		}
		source = patched;
	}
	return source;
}

export function makeNativePatchesPlugin(platform: BuildPlatform): esbuild.Plugin {
	return {
		name: "native-patches",
		setup(build) {
			if (platform === "web") return;
			for (const patch of NATIVE_PATCHES) {
				build.onLoad({ filter: patch.file }, async (args) => {
					const source = await fs.promises.readFile(args.path, "utf8");
					const patched = patchNativeSource(args.path, source);
					return patched === source ? undefined : { contents: patched, loader: "js" };
				});
			}
		},
	};
}
