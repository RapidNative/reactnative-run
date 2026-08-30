// SECURITY: input validation, the first of two layers guarding every
// subprocess in this server (execFile with an argv array is the second — see
// index.ts). These validators reject anything that isn't a canonical npm
// package name / version range BEFORE it can reach `npm`/`bun` or the
// filesystem. Even with execFile (so a string can't break a shell), validation
// still stops npm-flag injection (a name/version starting with `-`), path
// traversal (pkgName is used in path.join for node_modules), and pointless
// install attempts on junk input.
//
// Kept as a side-effect-free module so it can be unit-tested without booting
// the server (same convention as output.ts).

export const MAX_PKG_NAME_LEN = 214; // npm's own maximum
export const MAX_VERSION_LEN = 100;

// npm name grammar, intentionally stricter than npm itself: lowercase only,
// optional @scope/, must start alphanumeric, url-safe subset. Our clients only
// ever request canonical names, so anything else is hostile or malformed.
const PKG_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// Version: exact / semver range / dist-tag. Allowlist; every character here is
// inert as a single execFile argv element (the range operators <>|~^ are
// legitimate semver and can never inject because there is no shell). Only a
// literal space is allowed as whitespace (compound ranges like ">=1.0.0 <2.0.0")
// -- newlines/tabs and other control characters are rejected.
const VERSION_RE = /^[a-zA-Z0-9.\-+~^><=*| ]{1,100}$/;

export function isValidPackageName(name: unknown): name is string {
	if (typeof name !== "string" || name.length === 0 || name.length > MAX_PKG_NAME_LEN) return false;
	if (name.includes("..")) return false; // path-traversal belt-and-suspenders
	return PKG_NAME_RE.test(name);
}

export function isValidVersionRange(version: unknown): version is string {
	if (typeof version !== "string" || version.length === 0 || version.length > MAX_VERSION_LEN) return false;
	return VERSION_RE.test(version);
}
