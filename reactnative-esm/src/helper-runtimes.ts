/**
 * Helper runtimes a package can require without declaring them.
 *
 * A package compiled with Babel's transform-runtime (or tsc's importHelpers) requires its syntax
 * helpers from a runtime package -- `require("@babel/runtime/helpers/interopRequireDefault")`,
 * `require("tslib")` -- and should list that runtime as a dependency. Some don't.
 * @react-native-community/slider 5.2.0 requires four @babel/runtime helpers and declares no
 * dependencies at all. In an app the require resolves anyway, because something else in the app's
 * node_modules installed the runtime. The /pkg route installs the package on its own, so on web the
 * build fails with `Could not resolve "@babel/runtime/helpers/interopRequireDefault"`, and the
 * editor reports a package the server couldn't bundle. (Native externalizes what it can't resolve,
 * so the build succeeds there and the client fetches the helpers itself.)
 *
 * When a build fails only because such a runtime isn't installed, the route installs it and builds
 * again, so the helpers are inlined exactly as they are for a package that declares the runtime. A
 * package that declares its runtime never gets here, and neither does any build that succeeds
 * today, so no existing output changes.
 */
import { basePackageName } from "./chunk-externals";

/** The runtimes, with the range installed for each. @babel/runtime stays on 7, the line its helper paths come from. */
export const HELPER_RUNTIMES: Readonly<Record<string, string>> = {
	"@babel/runtime": "^7",
	tslib: "^2",
	"regenerator-runtime": "^0.14",
};

const UNRESOLVED_RE = /^Could not resolve "([^"]+)"/;

/**
 * The runtimes to install so a failed build resolves, as npm install specs, or [] when installing
 * would not fix it. Every error must be an unresolved import of a runtime that isn't installed: one
 * error of any other kind would fail the rebuild too, and a runtime that is installed but lacks a
 * helper won't gain it from a second install.
 */
export function helperRuntimesToInstall(
	errors: readonly { text?: string }[],
	isInstalled: (pkg: string) => boolean
): string[] {
	if (errors.length === 0) return [];
	const runtimes = new Set<string>();
	for (const err of errors) {
		const m = UNRESOLVED_RE.exec(err.text ?? "");
		if (!m) return [];
		const pkg = basePackageName(m[1]);
		if (!(pkg in HELPER_RUNTIMES) || isInstalled(pkg)) return [];
		runtimes.add(pkg);
	}
	return [...runtimes].map((pkg) => `${pkg}@${HELPER_RUNTIMES[pkg]}`);
}
