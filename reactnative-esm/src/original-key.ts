/**
 * "<name>__original" is browser-metro's synthetic key for the real module behind an override
 * (see handlePkgRequest). Returns the real package name, or the name unchanged.
 */
export function originalPackageName(pkgName: string): string {
	if (!pkgName.endsWith("__original")) return pkgName;
	const real = pkgName.slice(0, -"__original".length);
	// "@scope/__original" or "__original" alone is not a wrapped package.
	return real && !real.endsWith("/") ? real : pkgName;
}
