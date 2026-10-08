import fs from "fs";
import path from "path";
import type esbuild from "esbuild";
import type { BuildPlatform } from "./platform";

/**
 * Metro parity for package.json `react-native` / `browser` OBJECT maps on
 * native.
 *
 * A package can swap its own files, or its dependencies, per target.
 * engine.io-client (under socket.io-client) maps
 * "./transports/websocket.node.js" to its browser transport and "ws" to
 * false. Metro applies these maps on iOS/Android (both fields are in Expo's
 * native resolverMainFields, react-native winning), so the Node transport and
 * the `ws` package never reach an Expo bundle.
 *
 * esbuild applies the "browser" map ONLY for platform "browser", and native
 * builds are "neutral" (esbuildPlatformSettings), so here the maps were
 * ignored. socket.io-client pulled in `ws`, `ws` needs zlib/net/tls, the build
 * failed, and the dependency that imports it (@base44/sdk) shipped as
 * `module.exports = {}`. Apps on that SDK died at boot under rnrun with
 * "Cannot read property 'call' of undefined" while the same project ran under
 * Expo CLI and built on EAS.
 *
 * Mirrors metro-resolver 0.84 (PackageResolve: redirectModulePath,
 * getPackageEntryPoint):
 *   - rules come from the CLOSEST package.json, never looking past a
 *     node_modules segment (engine.io-client ships one per build directory);
 *   - a bare specifier is matched against the importing package's rules, a
 *     relative one by its package-relative path ("./" prefixed, posix);
 *   - keys match as written or with ".js"/".json" appended;
 *   - `false` is an empty module (one shared instance, like Metro's
 *     emptyModulePath), a string is the replacement: relative to the
 *     package.json that declared it, or another bare specifier;
 *   - a bare import of a package WITHOUT an "exports" field also honours that
 *     package's own rules for its entry point and subpaths. Metro resolves
 *     "exports" targets without consulting the maps, so this does not either.
 *
 * Native only: web builds run with platform "browser", where esbuild already
 * applies the "browser" map, and the web cache namespace is byte-frozen.
 */

/** Expo's native resolverMainFields, in precedence order. */
const MAIN_FIELDS = ["react-native", "browser", "main"];
const EMPTY_NAMESPACE = "package-map-empty";
/** Set on our own nested build.resolve so the redirect target resolves once. */
const REDIRECTED = "packageMapRedirected";

type Replacement = string | false;

export interface PackageRules {
	/** Directory holding the package.json the rules came from. */
	root: string;
	json: Record<string, unknown>;
	/** The merged object maps, or null when the package declares none. */
	map: Record<string, Replacement> | null;
}

export function readPackageRules(packageJsonPath: string): PackageRules | null {
	let json: unknown;
	try {
		json = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
	} catch {
		return null;
	}
	if (!json || typeof json !== "object") return null;
	const record = json as Record<string, unknown>;
	const objects = MAIN_FIELDS
		.map((field) => record[field])
		.filter((value): value is Record<string, Replacement> => value != null && typeof value === "object");
	return {
		root: path.dirname(packageJsonPath),
		json: record,
		// Reversed so the earlier field wins. Null prototype: keys are package
		// data, and "__proto__" must stay an ordinary key.
		map: objects.length ? Object.assign(Object.create(null), ...objects.reverse()) : null,
	};
}

export function matchReplacement(map: Record<string, Replacement>, variants: string[]): Replacement | undefined {
	for (const variant of variants) {
		const replacement = map[variant];
		if (replacement === false || typeof replacement === "string") return replacement;
	}
	return undefined;
}

const subpathVariants = (subpath: string) => [subpath, subpath + ".js", subpath + ".json"];

/** getPackageEntryPoint: the first string main field, in its four spellings. */
export function entryPointVariants(json: Record<string, unknown>): string[] {
	let main = "index";
	for (const field of MAIN_FIELDS) {
		const value = json[field];
		if (typeof value === "string" && value.length) {
			main = value;
			break;
		}
	}
	return [main, main.startsWith("./") ? main.slice(2) : "./" + main].flatMap((variant) => [
		variant,
		variant + ".js",
		variant + ".json",
		variant.replace(/(\.js|\.json)$/, ""),
	]);
}

function parseBareSpecifier(specifier: string): { name: string; subpath: string } | null {
	const parts = specifier.split("/");
	const nameParts = specifier.startsWith("@") ? 2 : 1;
	if (parts.length < nameParts || parts.slice(0, nameParts).some((part) => !part)) return null;
	return {
		name: parts.slice(0, nameParts).join("/"),
		subpath: parts.length > nameParts ? "./" + parts.slice(nameParts).join("/") : ".",
	};
}

const isPathSpecifier = (specifier: string) => /^\.\.?(?:\/|$)/.test(specifier) || path.isAbsolute(specifier);
const toPosix = (p: string) => p.split(path.sep).join("/");

export function makePackageMapsPlugin(platform: BuildPlatform): esbuild.Plugin {
	return {
		name: "package-json-maps",
		setup(build) {
			if (platform === "web") return;

			const closestCache = new Map<string, PackageRules | null>();
			const closestRules = (dir: string): PackageRules | null => {
				const cached = closestCache.get(dir);
				if (cached !== undefined) return cached;
				let rules: PackageRules | null = null;
				if (path.basename(dir) !== "node_modules") {
					const candidate = path.join(dir, "package.json");
					if (fs.existsSync(candidate)) {
						rules = readPackageRules(candidate);
					} else if (path.dirname(dir) !== dir) {
						rules = closestRules(path.dirname(dir));
					}
				}
				closestCache.set(dir, rules);
				return rules;
			};

			const rootCache = new Map<string, string | null>();
			const packageRoot = (fromDir: string, name: string): string | null => {
				const key = `${fromDir}\0${name}`;
				const cached = rootCache.get(key);
				if (cached !== undefined) return cached;
				let found: string | null = null;
				for (let dir = fromDir; ; dir = path.dirname(dir)) {
					if (path.basename(dir) !== "node_modules") {
						const candidate = path.join(dir, "node_modules", name);
						if (fs.existsSync(path.join(candidate, "package.json"))) {
							found = candidate;
							break;
						}
					}
					if (path.dirname(dir) === dir) break;
				}
				rootCache.set(key, found);
				return found;
			};

			const findRedirect = (args: esbuild.OnResolveArgs): { rules: PackageRules; to: Replacement } | null => {
				const specifier = args.path;
				if (isPathSpecifier(specifier)) {
					const target = path.resolve(args.resolveDir, specifier);
					const rules = closestRules(path.dirname(target));
					if (!rules?.map) return null;
					const to = matchReplacement(rules.map, subpathVariants("./" + toPosix(path.relative(rules.root, target))));
					return to === undefined ? null : { rules, to };
				}
				const own = closestRules(path.dirname(args.importer));
				if (own?.map) {
					const to = matchReplacement(own.map, subpathVariants(specifier));
					if (to !== undefined) return { rules: own, to };
				}
				const parsed = parseBareSpecifier(specifier);
				const root = parsed && packageRoot(args.resolveDir, parsed.name);
				const target = root ? closestRules(root) : null;
				if (!parsed || !target?.map || target.json.exports != null) return null;
				const to = matchReplacement(
					target.map,
					parsed.subpath === "." ? entryPointVariants(target.json) : subpathVariants(parsed.subpath),
				);
				return to === undefined ? null : { rules: target, to };
			};

			build.onResolve({ filter: /.*/ }, async (args) => {
				if (args.namespace !== "file" || !args.importer || args.pluginData?.[REDIRECTED]) return undefined;
				const redirect = findRedirect(args);
				if (!redirect) return undefined;
				if (redirect.to === false) return { path: "empty-module", namespace: EMPTY_NAMESPACE };
				const relative = isPathSpecifier(redirect.to);
				const result = await build.resolve(relative ? path.resolve(redirect.rules.root, redirect.to) : redirect.to, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: relative ? redirect.rules.root : args.resolveDir,
					pluginData: { [REDIRECTED]: true },
				});
				if (result.errors.length) return { errors: result.errors };
				return {
					path: result.path,
					namespace: result.namespace,
					external: result.external,
					sideEffects: result.sideEffects,
					suffix: result.suffix,
					pluginData: result.pluginData,
				};
			});

			build.onLoad({ filter: /.*/, namespace: EMPTY_NAMESPACE }, () => ({
				contents: "module.exports = {};",
				loader: "js",
			}));
		},
	};
}
