/**
 * Metro parity for side-effect (".fx") modules.
 *
 * Expo packages put import-time side effects in `*.fx.js` files and reach
 * them through ordinary imports, e.g. expo-notifications:
 *
 *   index.js:                  export { setAutoServerRegistrationEnabledAsync } from './DevicePushTokenAutoRegistration.fx';
 *   getExpoPushTokenAsync.js:  import { setAutoServerRegistrationEnabledAsync } from './DevicePushTokenAutoRegistration.fx';
 *
 * Under Metro (babel-preset-expo, inline requires) both become lazy: the .fx
 * module is only evaluated when a binding is actually used. esbuild
 * evaluates every statically imported module at init, so under rnrun the
 * side effect runs on every launch. For expo-notifications on Android in
 * Expo Go it throws (remote push was removed from Expo Go in SDK 53) and
 * the app red-screens on boot, while `expo start` boots fine.
 *
 * This transform restores Metro's behaviour for `.fx` modules only:
 *   - `export { a as b } from './x.fx'`  ->  `export function b(...args) { return require('./x.fx').a(...args); }`
 *   - `import { a as b } from './x.fx'`  ->  every use of `b` becomes `require('./x.fx').a`
 *   - `import * as ns from './x.fx'`     ->  every use of `ns` becomes `require('./x.fx')`
 *   - `import './x.fx'` (bare)           ->  untouched: Metro runs side-effect-only imports eagerly too
 *                                            (expo's own `Expo.fx` relies on that).
 * esbuild bundles a `require()`d ES module behind a lazy `__esm` init, so
 * evaluation is deferred to the first use. If a binding is referenced in a
 * position that cannot take an expression (e.g. re-exported by name) the file
 * is left untouched rather than half-rewritten.
 */

const FX_SPEC_RE = /^\.{1,2}\/.*\.fx(?:\.[cm]?jsx?)?$/;

/** Cheap pre-check so the AST pass only runs on files that import a .fx module. */
export function hasFxImport(src: string): boolean {
	return /from\s*['"]\.{1,2}\/[^'"]*\.fx(?:\.[cm]?jsx?)?['"]/.test(src);
}

export function isFxSpecifier(spec: string): boolean {
	return FX_SPEC_RE.test(spec);
}

type Babel = typeof import("@babel/core");

function lazyFxPlugin({ types: t }: Babel): import("@babel/core").PluginObj {
	const lazyMember = (spec: string, name: string | null) => {
		const req = t.callExpression(t.identifier("require"), [t.stringLiteral(spec)]);
		return name == null ? req : t.memberExpression(req, t.identifier(name));
	};
	const nameOf = (n: any): string => (n.type === "Identifier" ? n.name : String(n.value));
	return {
		name: "lazy-fx",
		visitor: {
			Program(programPath, state: any) {
				state.bail = false;
				state.changed = false;
			},
			ExportNamedDeclaration(path, state: any) {
				const src = path.node.source;
				if (!src || !isFxSpecifier(src.value)) return;
				const decls: any[] = [];
				for (const spec of path.node.specifiers) {
					if (spec.type !== "ExportSpecifier") {
						state.bail = true; // `export * as ns from` etc. -- leave the file alone
						return;
					}
					const local = nameOf(spec.local);
					const exported = nameOf(spec.exported);
					decls.push(
						t.exportNamedDeclaration(
							t.functionDeclaration(
								t.identifier(exported),
								[t.restElement(t.identifier("args"))],
								t.blockStatement([
									t.returnStatement(
										t.callExpression(lazyMember(src.value, local), [t.spreadElement(t.identifier("args"))]),
									),
								]),
							),
						),
					);
				}
				path.replaceWithMultiple(decls);
				state.changed = true;
			},
			ImportDeclaration(path, state: any) {
				const spec = path.node.source.value;
				if (!isFxSpecifier(spec)) return;
				if (path.node.specifiers.length === 0) return; // bare side-effect import: keep eager
				if (path.node.importKind === "type") return;
				const replacements: Array<{ refs: any[]; expr: () => any }> = [];
				for (const s of path.node.specifiers) {
					const localName = s.local.name;
					const binding = path.scope.getBinding(localName);
					if (!binding) {
						state.bail = true;
						return;
					}
					let imported: string | null;
					if (s.type === "ImportSpecifier") imported = nameOf(s.imported);
					else if (s.type === "ImportDefaultSpecifier") imported = "default";
					else imported = null; // namespace
					for (const ref of binding.referencePaths) {
						// Only plain expression positions can take `require(...).x`.
						if (!ref.isExpression() || ref.parentPath?.isExportSpecifier()) {
							state.bail = true;
							return;
						}
					}
					replacements.push({ refs: binding.referencePaths, expr: () => lazyMember(spec, imported) });
				}
				for (const r of replacements) for (const ref of r.refs) ref.replaceWith(r.expr());
				path.remove();
				state.changed = true;
			},
		},
	};
}

/** Rewrite every `.fx` import/re-export in `src` to a lazy form (see above). */
export async function rewriteFxImports(src: string, filename: string): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const babel = require("@babel/core") as Babel;
	let bailed = false;
	let changed = false;
	const result = await babel.transformAsync(src, {
		filename,
		babelrc: false,
		configFile: false,
		compact: false,
		retainLines: true,
		sourceMaps: false,
		parserOpts: { sourceType: "module", plugins: ["jsx"] },
		plugins: [
			(api: Babel) => {
				const plugin = lazyFxPlugin(api);
				const post = () => undefined;
				return {
					...plugin,
					post(this: any) {
						if (this.bail) bailed = true;
						if (this.changed) changed = true;
						post();
					},
				};
			},
		],
	});
	// Untouched files are returned byte-identical: Babel would otherwise
	// re-print them (quotes, semicolons) for no benefit.
	if (bailed || !changed || result?.code == null) return src;
	return result.code;
}
