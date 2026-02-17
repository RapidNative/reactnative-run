const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract all require('...') call targets from source */
export function findRequires(source: string): string[] {
  const requires: string[] = [];
  const re = new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    requires.push(match[1]);
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

/** Fast djb2 hash for cache invalidation */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
