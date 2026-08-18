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

