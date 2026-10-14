import type esbuild from "esbuild";

/**
 * Web leniency: should this bare import be left external because the build cannot resolve it?
 *
 * Some packages import a sibling they never declare at runtime. `@firebase/database` imports
 * `@firebase/app` but lists it only in devDependencies (the `firebase` umbrella provides it), so
 * it is neither in the external set nor installed beside the package, and the web build failed
 * with `Could not resolve "@firebase/app"`: HTTP 500, an empty module, the app dead on load. Native
 * builds already externalize such imports (the client resolves them from the app's own
 * dependencies); web did not.
 *
 * The web namespace is byte-frozen, so this must not change any build that works today. Native
 * decides with Node's `require.resolve`, which disagrees with esbuild on browser fields, export
 * conditions and `.web.js` files. Here esbuild itself decides: the import is probed through the
 * build's own resolver, and only an import that would fail the build is externalized. A build that
 * succeeds today resolves every import, so its output stays identical.
 *
 * Call it as the last step of an `onResolve` for bare imports, after the plugin's own decisions.
 * The probe re-enters that same callback with a marker in `pluginData`; the callback must then
 * return null so the resolution below it runs (this function returns false for the probe itself).
 */
export const WEB_LENIENCY_PROBE = "rnWebLeniencyProbe";

export async function unresolvableOnWeb(build: esbuild.PluginBuild, args: esbuild.OnResolveArgs): Promise<boolean> {
	if (args.pluginData?.[WEB_LENIENCY_PROBE]) return false;
	const result = await build.resolve(args.path, {
		kind: args.kind,
		importer: args.importer,
		resolveDir: args.resolveDir,
		namespace: args.namespace,
		pluginData: { [WEB_LENIENCY_PROBE]: true },
	});
	return result.errors.length > 0;
}
