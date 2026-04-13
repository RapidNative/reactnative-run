const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Dynamic `import("x")`. Use a negative lookbehind to avoid matching `.import(`
// (e.g. method calls) and require `import` to be a standalone keyword.
const DYNAMIC_IMPORT_RE = /(?<![.$\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Matches lines that are single-line comments or JSDoc/block comment continuations
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/?\*)/;
const EXTERNALS_RE = /^\/\/ @externals (.+)$/m;
const DEP_MANIFEST_RE = /^\/\/ @dep-manifest (.+)$/m;
const DEP_START_RE = /^\/\/ @dep-start (.+)$/gm;
const DEP_END_RE = /^\/\/ @dep-end (.+)$/gm;

/** Parse externals metadata from a package bundle body.
 *  Looks for a `// @externals {...}` comment line near the top.
 *  Falls back to empty object if not found. */
export function parseExternalsFromBody(code: string): Record<string, string> {
  const match = EXTERNALS_RE.exec(code);
  if (!match) return {};
  try { return JSON.parse(match[1]); } catch { return {}; }
}

/** Extract all require('...') and dynamic import('...') call targets from source */
export function findRequires(source: string): string[] {
  if (!source) return [];
  const requires: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines to avoid picking up require() in JSDoc examples
    if (COMMENT_LINE_RE.test(line)) continue;
    const reqRe = new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = reqRe.exec(line)) !== null) {
      requires.push(match[1]);
    }
    const impRe = new RegExp(DYNAMIC_IMPORT_RE.source, DYNAMIC_IMPORT_RE.flags);
    while ((match = impRe.exec(line)) !== null) {
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
  const requireRewritten = source.replace(
    REQUIRE_RE,
    (full: string, target: string): string => {
      const resolved = resolveTarget(target);
      if (resolved === null) return full;
      return 'require("' + resolved + '")';
    },
  );
  // Lower dynamic `import("x")` so it flows through the same module registry
  // as static requires. Wrap the result with __esModule interop so callers
  // like React.lazy — which expect a module namespace with `.default` —
  // work for plain CJS modules whose `module.exports` is the value itself.
  return rewriteDynamicImports(requireRewritten, (target) => {
    const resolved = resolveTarget(target);
    return resolved === null ? target : resolved;
  });
}

/**
 * Lower dynamic `import("x")` without rewriting require targets. Used for
 * prebundled npm package code where specifiers are already registry keys.
 */
export function lowerDynamicImports(source: string): string {
  return rewriteDynamicImports(source, (target) => target);
}

function loweredDynamicImport(id: string): string {
  return (
    'Promise.resolve().then(function(){var m=require("' +
    id +
    '");return m&&m.__esModule?m:{default:m};})'
  );
}

/**
 * Tokenizer-aware lowering of `import("x")` calls. Skips string literals,
 * template literals, regex literals, and comments so we never corrupt source
 * that merely *mentions* dynamic imports inside text (e.g. React's own
 * "lazy: Expected the result of a dynamic import()" error message).
 */
function rewriteDynamicImports(
  source: string,
  resolveId: (target: string) => string,
): string {
  let out = "";
  let i = 0;
  const n = source.length;
  // Track the last non-whitespace code character so we can disambiguate
  // `/` as the start of a regex literal vs. division.
  let lastCode = "";

  const isIdent = (c: string) => /[\w$]/.test(c);
  // Chars that, when seen as the previous significant token, mean a `/` next
  // begins a regex literal, not division.
  const REGEX_PREV = new Set([
    "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+",
    "-", "*", "/", "%", "^", "~", "<", ">",
  ]);
  // Identifier keywords that allow a following regex.
  const REGEX_KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "case", "do", "else", "yield", "await",
  ]);

  const prevIdent = (): string => {
    let j = out.length - 1;
    while (j >= 0 && isIdent(out[j])) j--;
    return out.slice(j + 1);
  };

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];

    // Line comment
    if (c === "/" && c2 === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    // Block comment
    if (c === "/" && c2 === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    // String literal
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const ch = source[i];
        out += ch;
        i++;
        if (ch === "\\" && i < n) { out += source[i]; i++; continue; }
        if (ch === quote) break;
      }
      lastCode = quote;
      continue;
    }
    // Template literal — naive: skip nested ${...} by depth tracking.
    if (c === "`") {
      out += c;
      i++;
      let depth = 0;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\" && i + 1 < n) { out += ch + source[i + 1]; i += 2; continue; }
        if (depth === 0 && ch === "`") { out += ch; i++; break; }
        if (depth === 0 && ch === "$" && source[i + 1] === "{") {
          out += "${"; i += 2; depth++; continue;
        }
        if (depth > 0 && ch === "{") { depth++; out += ch; i++; continue; }
        if (depth > 0 && ch === "}") { depth--; out += ch; i++; continue; }
        out += ch; i++;
      }
      lastCode = "`";
      continue;
    }
    // Regex literal — only if `/` is in a position where regex is allowed.
    if (c === "/") {
      const ident = prevIdent();
      const allowRegex = REGEX_PREV.has(lastCode) || REGEX_KEYWORDS.has(ident);
      if (allowRegex) {
        out += c;
        i++;
        let inClass = false;
        while (i < n) {
          const ch = source[i];
          out += ch;
          i++;
          if (ch === "\\" && i < n) { out += source[i]; i++; continue; }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
        }
        // consume regex flags
        while (i < n && /[gimsuy]/.test(source[i])) { out += source[i]; i++; }
        lastCode = "/";
        continue;
      }
    }

    // Try to match dynamic `import(...)` here.
    // Boundary: previous code char must not be part of an identifier/member.
    if (
      c === "i" &&
      source.startsWith("import", i) &&
      !isIdent(out[out.length - 1] || "") &&
      out[out.length - 1] !== "." &&
      out[out.length - 1] !== "$"
    ) {
      let j = i + 6;
      while (j < n && (source[j] === " " || source[j] === "\t")) j++;
      if (source[j] === "(") {
        let k = j + 1;
        while (k < n && /\s/.test(source[k])) k++;
        const q = source[k];
        if (q === '"' || q === "'") {
          let m = k + 1;
          let target = "";
          let bad = false;
          while (m < n && source[m] !== q) {
            if (source[m] === "\\") { bad = true; break; }
            target += source[m];
            m++;
          }
          if (!bad && source[m] === q) {
            let p = m + 1;
            while (p < n && /\s/.test(source[p])) p++;
            if (source[p] === ")") {
              const id = resolveId(target);
              out += loweredDynamicImport(id);
              i = p + 1;
              lastCode = ")";
              continue;
            }
          }
        }
      }
    }

    out += c;
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out;
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

// Must match SERVER_VERSION in reactnative-esm/src/index.ts
const DEPS_HASH_VERSION = "2";

/** Hash a dependencies object to a stable cache key.
 *  Uses SHA-256 (via Web Crypto or Node crypto) truncated to 16 hex chars
 *  for collision resistance while keeping URLs short.
 *  Includes a version prefix so cache is invalidated when bundling logic changes. */
export async function hashDeps(deps: Record<string, string>): Promise<string> {
  const sorted = Object.keys(deps).sort().map(k => `${k}@${deps[k]}`).join(",");
  const input = `v${DEPS_HASH_VERSION}:${sorted}`;

  // Web Crypto API (works in browsers and workers)
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const data = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  // Fallback: djb2 (Node.js without crypto, shouldn't normally happen)
  return hashString(input);
}

/** Parse a dep bundle response into individual package code chunks.
 *  Format: `// @dep-start <name>\n..code..\n// @dep-end <name>` */
export function parseDepBundle(code: string): { manifest: Record<string, string>; packages: Record<string, string> } {
  let manifest: Record<string, string> = {};
  const manifestMatch = DEP_MANIFEST_RE.exec(code);
  if (manifestMatch) {
    try { manifest = JSON.parse(manifestMatch[1]); } catch {}
  }

  const packages: Record<string, string> = {};
  const startRe = /^\/\/ @dep-start (.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = startRe.exec(code)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length + 1; // skip newline
    const endMarker = `// @dep-end ${name}`;
    const endIdx = code.indexOf(endMarker, startIdx);
    if (endIdx !== -1) {
      packages[name] = code.slice(startIdx, endIdx).trimEnd();
    }
  }

  return { manifest, packages };
}
