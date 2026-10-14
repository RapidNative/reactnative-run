import type esbuild from "esbuild";
import { builtinModules } from "module";
import fs from "fs";
import path from "path";

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

/**
 * Node built-ins are never externalized here. On web the client fetches every external it finds
 * and a fetch that fails fails the whole preview, while a package that fails to build is only an
 * empty stub. `react-dom/server` and `sql.js` import `util`, `node:fs` and friends and sit in most
 * apps' dependency sets as harmless empty stubs; externalizing their built-ins would have turned
 * that into a broken preview for every one of those apps.
 */
const NODE_BUILTINS = new Set(builtinModules);
export function isNodeBuiltin(specifier: string): boolean {
	if (specifier.startsWith("node:")) return true;
	return NODE_BUILTINS.has(specifier.split("/")[0]);
}

/** "@scope/pkg/sub" -> "@scope/pkg"; "pkg/sub" -> "pkg". */
function baseName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const manifestCache = new Map<string, Record<string, unknown> | null>();
/** The package.json of the package that owns `file`: the nearest one above it with a name. */
function owningManifest(file: string): Record<string, unknown> | null {
	let dir = path.dirname(file);
	while (true) {
		const cached = manifestCache.get(dir);
		if (cached !== undefined) return cached;
		const candidate = path.join(dir, "package.json");
		if (fs.existsSync(candidate)) {
			try {
				const json = JSON.parse(fs.readFileSync(candidate, "utf-8"));
				if (json && typeof json.name === "string") {
					manifestCache.set(dir, json);
					return json;
				}
			} catch {}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Only an import the importing package declares in its own devDependencies: the "forgot to
 * declare it at runtime" bug (@firebase/database -> @firebase/app, slider -> @babel/runtime).
 * Anything else stays a build failure, because the client fails the whole web preview on an
 * external it can't fetch (a types-only package, a bare "firebase", a package that doesn't build
 * for web), while a failed build is only an empty stub.
 */
export function declaredAsDevDependency(importer: string, specifier: string): boolean {
	if (!importer) return false;
	const manifest = owningManifest(importer);
	const dev = (manifest?.devDependencies ?? {}) as Record<string, unknown>;
	return Object.prototype.hasOwnProperty.call(dev, baseName(specifier));
}

export async function unresolvableOnWeb(build: esbuild.PluginBuild, args: esbuild.OnResolveArgs): Promise<boolean> {
	if (args.pluginData?.[WEB_LENIENCY_PROBE]) return false;
	if (isNodeBuiltin(args.path)) return false;
	if (!declaredAsDevDependency(args.importer, args.path)) return false;
	const result = await build.resolve(args.path, {
		kind: args.kind,
		importer: args.importer,
		resolveDir: args.resolveDir,
		namespace: args.namespace,
		pluginData: { [WEB_LENIENCY_PROBE]: true },
	});
	return result.errors.length > 0;
}
