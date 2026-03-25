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
 * The iframe is loaded via a blob URL with the initial route encoded in the
 * hash fragment (e.g. blob:origin/uuid#/explore). Location properties are
 * [LegacyUnforgeable] so we can't override them, but we CAN call the real
 * replaceState to change the blob URL's pathname from the UUID to the
 * virtual path. After that, location.pathname returns the correct value
 * for Expo Router's initial route match.
 *
 * All subsequent pushState/replaceState calls are intercepted so no further
 * real URL changes occur. The current virtual route is stored in
 * window.__ROUTER_SHIM_HASH__ for the parent to read across iframe rebuilds.
 */
export function buildRouterShim(): string {
  return `(function() {
  var rawHash = location.hash.slice(1) || '/';

  var hashIdx = rawHash.indexOf('#');
  var virtualHash = '';
  var pathAndSearch = rawHash;
  if (hashIdx > 0) {
    virtualHash = rawHash.slice(hashIdx);
    pathAndSearch = rawHash.slice(0, hashIdx);
  }

  var searchIdx = pathAndSearch.indexOf('?');
  var virtualPathname = searchIdx >= 0 ? pathAndSearch.slice(0, searchIdx) : pathAndSearch;
  var virtualSearch = searchIdx >= 0 ? pathAndSearch.slice(searchIdx) : '';

  if (virtualPathname.charAt(0) !== '/') virtualPathname = '/' + virtualPathname;

  var virtualOrigin = location.origin || 'http://localhost';
  var virtualHref = virtualOrigin + virtualPathname + virtualSearch + virtualHash;

  // Override document.URL (configurable, unlike location.*)
  try {
    Object.defineProperty(Document.prototype, 'URL', {
      get: function() { return virtualHref; },
      configurable: true
    });
  } catch(e) {}

  // Wrap URL constructor so new URL(location.href) returns the virtual URL
  // instead of parsing the blob UUID as a pathname.
  var OrigURL = URL;
  var _URL = function(url, base) {
    var u = String(url);
    if (u.indexOf('blob:') === 0) u = virtualHref;
    if (arguments.length > 1) return new OrigURL(u, base);
    return new OrigURL(u);
  };
  _URL.prototype = OrigURL.prototype;
  _URL.createObjectURL = OrigURL.createObjectURL;
  _URL.revokeObjectURL = OrigURL.revokeObjectURL;
  _URL.canParse = OrigURL.canParse;
  window.URL = _URL;

  // Save real replaceState before overriding
  var _realReplaceState = history.replaceState;
  // Base blob URL without hash, for constructing absolute URLs in sync()
  var _blobBase = location.href.split('#')[0];

  var stack = [{ state: null, pathname: virtualPathname, search: virtualSearch, hash: virtualHash }];
  var stackIndex = 0;

  function currentEntry() { return stack[stackIndex]; }

  function sync() {
    var e = currentEntry();
    virtualPathname = e.pathname;
    virtualSearch = e.search;
    virtualHash = e.hash;
    virtualHref = virtualOrigin + virtualPathname + virtualSearch + virtualHash;
    var routeHash = '#' + e.pathname + e.search;
    window.__ROUTER_SHIM_HASH__ = routeHash;
    // Update the real blob URL hash, but only if it actually changed.
    var newUrl = _blobBase + routeHash;
    if (newUrl !== location.href) {
      try { _realReplaceState.call(history, e.state, '', newUrl); } catch(e) {}
    }
  }

  function parseUrl(url) {
    var s = String(url);
    if (s.indexOf('blob:') === 0) {
      try { var inner = new OrigURL(s.slice(5)); s = inner.pathname + inner.search + inner.hash; } catch(e) {}
    }
    try {
      var u = new OrigURL(s, virtualOrigin);
      return { pathname: u.pathname, search: u.search, hash: u.hash };
    } catch(e) {}
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
      // Ignore hash: it's our own route hash echoed back from location.hash
      stack = stack.slice(0, stackIndex + 1);
      stack.push({ state: state, pathname: p.pathname, search: p.search, hash: '' });
      stackIndex = stack.length - 1;
      sync();
    }
  };

  history.replaceState = function(state, title, url) {
    if (url != null) {
      var p = parseUrl(url);
      stack[stackIndex] = { state: state, pathname: p.pathname, search: p.search, hash: '' };
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
