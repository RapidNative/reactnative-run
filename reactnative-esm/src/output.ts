import path from "path";

/**
 * Metro parity for class FIELDS.
 *
 * esbuild lowers `class { field = v }` with spec semantics: its
 * `__defNormalProp` helper does `key in obj ? Object.defineProperty(...) :
 * obj[key] = v`. Metro compiles the whole RN ecosystem with
 * @react-native/babel-preset, which enables LOOSE class fields
 * (setPublicClassFields), i.e. a plain `this.field = v` assignment.
 *
 * The difference is not academic: a field that shadows an inherited
 * writable-but-non-configurable property (or any property `[[Define]]`
 * rejects) throws "property is not configurable" under the spec path while
 * the loose assignment succeeds. RN's own VirtualizedList hits exactly this
 * on device, so an app using FlatList redboxes under esbuild output but works
 * under Metro. Rewrite the helper to the loose form to match.
 *
 * Anchored on esbuild's exact helper text; if that ever changes shape we log
 * and ship the original rather than silently mangling the chunk.
 */
const ESBUILD_DEFNORMALPROP_RE =
	/var __defNormalProp = \(obj, key, value\) => key in obj \? __defProp\(obj, key, \{[^}]*\}\) : obj\[key\] = value;/;
export function looseClassFields(code: string, label: string): string {
	if (!code.includes("__defNormalProp")) return code;
	if (!ESBUILD_DEFNORMALPROP_RE.test(code)) {
		console.warn(`[loose-class-fields] helper shape not recognised in ${label}; leaving spec semantics in place`);
		return code;
	}
	return code.replace(
		ESBUILD_DEFNORMALPROP_RE,
		"var __defNormalProp = (obj, key, value) => (obj[key] = value);"
	);
}

/**
 * esbuild writes each module's path into a comment banner, and ours live in a
 * per-request mkdtemp directory -- so the SAME package built twice produces
 * byte-different output purely because of a random directory name. Two costs:
 *
 *  1. it leaks absolute server paths into every user's bundle, and into device
 *     stack traces (Hermes warnings and LogBox frames read
 *     "../../../tmp/bundle-deps-Q4Z5ZQ/node_modules/...");
 *  2. it makes chunks impossible to content-address, which is what per-package
 *     chunk reuse across dependency sets needs.
 *
 * Normalising the build root to a stable token fixes both. Measured: with this
 * applied, a package's chunk is byte-identical across different dependency
 * sets (the only remaining variance is the externals decision, which is
 * intentional and part of the cache key).
 */
export function normalizeBuildPaths(code: string, tmpDir: string): string {
	const base = path.basename(tmpDir);
	// The literal directory name, however esbuild spelled the path to it.
	let out = code.split(base).join("__pkgroot__");
	// Any residual traversal prefix down to the temp root (platform-dependent:
	// /tmp/... on Linux, /private/var/folders/**/T/... on macOS).
	out = out.replace(/(?:\.\.\/)+(?:private\/)?var\/folders\/[^\s"']*?\/T\//g, "");
	out = out.replace(/(?:\.\.\/)+tmp\//g, "");
	return out;
}


/**
 * Degrade CSS animations/transitions to static on native for the ONE known
 * fatal pairing: react-native-css-interop 0.2.x with react-native-reanimated
 * >= 4. css-interop 0.2.1 drives keyframe animations and transitions by
 * scheduling a worklet on reanimated's UI runtime (makeMutable/withRepeat/
 * withTiming), and its peer range (>=3.6.2) predates reanimated 4's rewrite.
 * On rea 4 that worklet throws on the UI thread, where there is no redbox --
 * Hermes rethrows and the process SIGABRTs. Any generated app with an
 * animate-pulse skeleton or animate-spin loader crashes on load.
 *
 * The compiled data carries the trigger as `animations`/`transition` on each
 * rule variant plus a top-level `keyframes` map. Dropping those (keeping the
 * static declarations `d`) makes such classes render static -- a still
 * skeleton instead of a crash. Gated on the version pairing, so it stops
 * automatically once a css-interop that supports reanimated 4 ships. The
 * animation DATA is what changes the bytes, and versions are already in the
 * cache key, so caching the degraded result is correct.
 */
export function degradeIncompatibleAnimations(data: unknown, versions: Record<string, string>): number {
	const interop = (versions["react-native-css-interop"] || "").replace(/^[\^~]/, "");
	const rea = (versions["react-native-reanimated"] || "").replace(/^[\^~]/, "");
	const reaMajor = parseInt(rea.split(".")[0], 10);
	if (!interop.startsWith("0.2.") || !Number.isFinite(reaMajor) || reaMajor < 4) return 0;
	if (!data || typeof data !== "object") return 0;
	const d = data as { rules?: Record<string, { n?: Array<Record<string, unknown>> }>; keyframes?: unknown };
	let stripped = 0;
	for (const rule of Object.values(d.rules ?? {})) {
		for (const variant of rule.n ?? []) {
			if ("animations" in variant) { delete variant.animations; stripped++; }
			if ("transition" in variant) { delete variant.transition; stripped++; }
		}
	}
	// Keyframes are now unreferenced; drop them so nothing can schedule one.
	if (d.keyframes) d.keyframes = {};
	return stripped;
}

