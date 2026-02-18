const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Matches lines that are single-line comments or JSDoc/block comment continuations
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/?\*)/;

/** Extract all require('...') call targets from source */
export function findRequires(source: string): string[] {
  if (!source) return [];
  const requires: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines to avoid picking up require() in JSDoc examples
    if (COMMENT_LINE_RE.test(line)) continue;
    const re = new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      requires.push(match[1]);
    }
  }
  return requires;
}

/**
 * Rewrite require calls using a resolve callback.
 * resolveTarget returns a string to rewrite to, or null to leave unchanged.
 */
export function rewriteRequires(
  source: string,
  fromFile: string,
  resolveTarget: (target: string) => string | null,
): string {
  return source.replace(
    REQUIRE_RE,
    (full: string, target: string): string => {
      const resolved = resolveTarget(target);
      if (resolved === null) return full;
      return 'require("' + resolved + '")';
    },
  );
}

const PUBLIC_ENV_PREFIXES = ["EXPO_PUBLIC_", "NEXT_PUBLIC_"];

/**
 * Build the bundle preamble (Metro-style). Defines `process` global so npm
 * packages that check `process.env.NODE_ENV` work in the browser.
 * Optionally injects public env vars (EXPO_PUBLIC_*, NEXT_PUBLIC_*).
 */
export function buildBundlePreamble(env?: Record<string, string>): string {
  let preamble =
    "var process = globalThis.process || {};\n" +
    "process.env = process.env || {};\n" +
    'process.env.NODE_ENV = process.env.NODE_ENV || "development";\n';

  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (PUBLIC_ENV_PREFIXES.some((p) => key.startsWith(p))) {
        preamble += "process.env." + key + " = " + JSON.stringify(value) + ";\n";
      }
    }
  }

  return preamble;
}

/** Fast djb2 hash for cache invalidation */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
