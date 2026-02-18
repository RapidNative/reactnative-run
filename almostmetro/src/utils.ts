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
 * Optionally appends the router shim for virtualizing History/Location APIs.
 */
export function buildBundlePreamble(env?: Record<string, string>, routerShim?: boolean): string {
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

  if (routerShim) {
    preamble += buildRouterShim();
  }

  return preamble;
}

/**
 * Build a self-contained IIFE that virtualizes the History API.
 *
 * The iframe is loaded via doc.write() (same-origin), so location.pathname
 * already returns '/' (the parent's path). Location properties are
 * [LegacyUnforgeable] (non-configurable own properties on window.location)
 * and CANNOT be overridden with Object.defineProperty. That's fine -- the
 * real pathname '/' is correct for Expo Router's initial route match.
 *
 * The shim only intercepts history.pushState / replaceState / go / back /
 * forward so that navigation stays virtual (no real URL changes that would
 * bleed to the parent's address bar). The current virtual route is stored
 * in window.__ROUTER_SHIM_HASH__ for the parent to read and restore
 * across iframe rebuilds.
 */
export function buildRouterShim(): string {
  return `(function() {
  var saved = window.__ROUTER_SHIM_HASH__ || '';
  var rawRoute = saved ? saved.slice(1) : '/';

  var hashIdx = rawRoute.indexOf('#');
  var virtualHash = '';
  var pathAndSearch = rawRoute;
  if (hashIdx > 0) {
    virtualHash = rawRoute.slice(hashIdx);
    pathAndSearch = rawRoute.slice(0, hashIdx);
  }

  var searchIdx = pathAndSearch.indexOf('?');
  var virtualPathname = searchIdx >= 0 ? pathAndSearch.slice(0, searchIdx) : pathAndSearch;
  var virtualSearch = searchIdx >= 0 ? pathAndSearch.slice(searchIdx) : '';

  if (virtualPathname.charAt(0) !== '/') virtualPathname = '/' + virtualPathname;

  var stack = [{ state: null, pathname: virtualPathname, search: virtualSearch, hash: virtualHash }];
  var stackIndex = 0;

  function currentEntry() { return stack[stackIndex]; }

  function sync() {
    var e = currentEntry();
    window.__ROUTER_SHIM_HASH__ = '#' + e.pathname + e.search + e.hash;
  }

  function parseUrl(url) {
    try {
      var u = new URL(url, location.origin);
      return { pathname: u.pathname, search: u.search, hash: u.hash };
    } catch(e) {}
    var s = String(url);
    var pathname = s, search = '', hash = '';
    var hi = pathname.indexOf('#');
    if (hi >= 0) { hash = pathname.slice(hi); pathname = pathname.slice(0, hi); }
    var si = pathname.indexOf('?');
    if (si >= 0) { search = pathname.slice(si); pathname = pathname.slice(0, si); }
    if (!pathname) pathname = '/';
    if (pathname.charAt(0) !== '/') pathname = '/' + pathname;
    return { pathname: pathname, search: search, hash: hash };
  }

  history.pushState = function(state, title, url) {
    if (url != null) {
      var p = parseUrl(url);
      stack = stack.slice(0, stackIndex + 1);
      stack.push({ state: state, pathname: p.pathname, search: p.search, hash: p.hash });
      stackIndex = stack.length - 1;
      sync();
    }
  };

  history.replaceState = function(state, title, url) {
    if (url != null) {
      var p = parseUrl(url);
      stack[stackIndex] = { state: state, pathname: p.pathname, search: p.search, hash: p.hash };
      sync();
    }
  };

  history.go = function(n) {
    if (!n) return;
    var ni = stackIndex + n;
    if (ni < 0) ni = 0;
    if (ni >= stack.length) ni = stack.length - 1;
    if (ni === stackIndex) return;
    stackIndex = ni;
    sync();
    window.dispatchEvent(new PopStateEvent('popstate', { state: currentEntry().state }));
  };
  history.back = function() { history.go(-1); };
  history.forward = function() { history.go(1); };

  Object.defineProperty(history, 'state', {
    get: function() { return currentEntry().state; },
    configurable: true
  });

  sync();
})();
`;
}

/** Fast djb2 hash for cache invalidation */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
