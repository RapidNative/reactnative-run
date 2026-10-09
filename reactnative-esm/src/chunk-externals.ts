/**
 * Which batch members a chunk's bytes depend on, for its cache key.
 *
 * The batch-external plugins externalize ANY import of a batch member (a direct dependency of the
 * requested set), including one made by a dependency the chunk inlines. So a chunk's externals
 * depend on the package's whole dependency closure, not just on what it declares itself, and a
 * subpath chunk ("react-native/Libraries/Core/setUpXHR") has no package.json of its own at all.
 *
 * Observed: an app that listed `event-target-shim` built react-native's subpath chunks with it
 * external (react-native -> abort-controller -> event-target-shim), and another app, which never
 * listed it, was served those chunks: its bundle required a module its batch did not provide. The
 * reverse direction inlines a second copy of a package the app also has as its own chunk, which
 * breaks anything that keeps state (contexts, registries).
 *
 * The walk stops at batch members: they are externalized, so nothing beneath them enters the chunk.
 * A package whose closure reaches no extra batch member keeps exactly the key it had.
 */

/** "react-native/Libraries/x" → "react-native"; "@scope/pkg/sub" → "@scope/pkg". */
export function basePackageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The batch members reachable from `pkgName`'s dependencies, sorted. */
export function relevantExternals(
	pkgName: string,
	batch: Set<string>,
	declaredDepsOf: (name: string) => string[]
): string[] {
	const base = basePackageName(pkgName);
	const seen = new Set<string>();
	const relevant = new Set<string>();
	const queue = [...declaredDepsOf(base)];
	while (queue.length) {
		const dep = queue.pop()!;
		if (dep === base || seen.has(dep)) continue;
		seen.add(dep);
		if (batch.has(dep)) {
			relevant.add(dep);
			continue;
		}
		queue.push(...declaredDepsOf(dep));
	}
	return [...relevant].sort();
}
