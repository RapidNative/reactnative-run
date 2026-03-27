import { countNewlines } from "../source-map.js";
import { Transformer } from "../types.js";
import { typescriptTransformer } from "./typescript.js";

function isJsxFile(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

/**
 * Extract a hook signature string from source.
 *
 * Returns the full ordered sequence of hook calls (with duplicates), joined by
 * newline. This is passed to $RefreshSig$ so React Refresh can detect ANY change
 * that affects the hook fiber chain — including adding a second call to an
 * already-present hook (e.g. a second useMutation).
 *
 * Why NOT deduplicate: if we used a Set, adding a second `useMutation` would
 * leave the signature unchanged → React Refresh would attempt an in-place update
 * → "Rendered more hooks than during the previous render" crash. The full
 * ordered sequence changes whenever hook count or order changes, so React
 * Refresh always forces a clean remount instead.
 */
function extractHookSignature(src: string): string {
  const hooks: string[] = [];
  const re = /\buse[A-Z][a-zA-Z0-9]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    hooks.push(m[0]);
  }
  return hooks.join('\n');
}

/**
 * Detect React component names from source code.
 * Heuristic: any function or const/let with an uppercase first letter.
 * We scan BOTH original source (catches `export default function App`)
 * and transformed output (catches sucrase rewrites like `function App`).
 */
function detectComponents(originalSrc: string, transformedCode: string): string[] {
  const seen = new Set<string>();
  const components: string[] = [];

  // Patterns to match component-like declarations
  const patterns = [
    // function Foo(, export function Foo(, export default function Foo(
    /(?:export\s+(?:default\s+)?)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
    // const Foo =, let Foo =, var Foo =  (covers arrow components, React.memo, etc.)
    /(?:export\s+)?(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*=/g,
  ];

  for (const src of [originalSrc, transformedCode]) {
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        const name = match[1];
        if (!seen.has(name)) {
          seen.add(name);
          components.push(name);
        }
      }
    }
  }

  return components;
}

/** Wrap a base transformer with React Refresh instrumentation for .tsx/.jsx files */
export function createReactRefreshTransformer(base: Transformer): Transformer {
  return {
    transform(params) {
      const result = base.transform(params);

      if (!isJsxFile(params.filename)) {
        return result;
      }

      const components = detectComponents(params.src, result.code);
      if (components.length === 0) {
        return result;
      }

      // Compute hook signature for this module — changes when hooks are added/removed
      const hookSig = extractHookSignature(params.src + result.code);

      // Check if module uses createContext (needs HMR identity preservation)
      const usesCreateContext =
        params.src.includes('createContext') || result.code.includes('createContext');

      // Preamble: set up refresh hooks scoped to this module + signature vars per component
      let preamble =
        'var _prevRefreshReg = window.$RefreshReg$;\n' +
        'var _prevRefreshSig = window.$RefreshSig$;\n' +
        'var _refreshModuleId = ' + JSON.stringify(params.filename) + ';\n' +
        'window.$RefreshReg$ = function(type, id) {\n' +
        '  if (window.__REACT_REFRESH_RUNTIME__) {\n' +
        '    window.__REACT_REFRESH_RUNTIME__.register(type, _refreshModuleId + " " + id);\n' +
        '  }\n' +
        '};\n' +
        'window.$RefreshSig$ = function() {\n' +
        '  if (window.__REACT_REFRESH_RUNTIME__) {\n' +
        '    return window.__REACT_REFRESH_RUNTIME__.createSignatureFunctionForTransform();\n' +
        '  }\n' +
        '  return function(type) { return type; };\n' +
        '};\n';
      // One signature function per component — enables hooks-change detection
      for (const name of components) {
        preamble += 'var _s_' + name + ' = $RefreshSig$();\n';
      }

      // Context identity preservation: patch React.createContext so that on HMR
      // re-executions the same context object is returned instead of a new one.
      // Without this, Provider uses a new context reference while consumers still
      // hold the old one → useContext() returns null → "must be used within Provider".
      // Contexts are keyed by moduleId + call-order index and stored in
      // window.__HMR_CONTEXTS__ which persists across re-executions.
      if (usesCreateContext) {
        preamble +=
          'var _hmrCtxIdx = 0;\n' +
          'var _hmrOrigCC;\n' +
          'try {\n' +
          '  var _hmrReact = require("react");\n' +
          '  _hmrOrigCC = _hmrReact.createContext;\n' +
          '  if (!window.__HMR_CONTEXTS__) window.__HMR_CONTEXTS__ = {};\n' +
          '  _hmrReact.createContext = function(defaultValue) {\n' +
          '    var key = _refreshModuleId + ":ctx:" + (_hmrCtxIdx++);\n' +
          '    if (window.__HMR_CONTEXTS__[key]) return window.__HMR_CONTEXTS__[key];\n' +
          '    var ctx = _hmrOrigCC(defaultValue);\n' +
          '    window.__HMR_CONTEXTS__[key] = ctx;\n' +
          '    return ctx;\n' +
          '  };\n' +
          '} catch(_e) {}\n';
      }

      // Postamble: register each component and accept HMR
      let postamble = '\n';
      for (const name of components) {
        postamble +=
          'if (typeof ' + name + ' === "function") {\n' +
          '  _s_' + name + '(' + name + ', ' + JSON.stringify(hookSig) + ');\n' +
          '  $RefreshReg$(' + name + ', ' + JSON.stringify(name) + ');\n' +
          '}\n';
      }
      // Restore original React.createContext after module body runs
      if (usesCreateContext) {
        postamble +=
          'if (_hmrOrigCC) {\n' +
          '  try { require("react").createContext = _hmrOrigCC; } catch(_e) {}\n' +
          '}\n';
      }
      postamble +=
        'window.$RefreshReg$ = _prevRefreshReg;\n' +
        'window.$RefreshSig$ = _prevRefreshSig;\n' +
        'if (module.hot) {\n' +
        '  module.hot.accept();\n' +
        '}\n';

      // Offset source map to account for preamble lines
      let sourceMap = result.sourceMap;
      if (sourceMap) {
        const preambleLines = countNewlines(preamble);
        sourceMap = {
          ...sourceMap,
          mappings: ";".repeat(preambleLines) + sourceMap.mappings,
        };
      }

      return { code: preamble + result.code + postamble, sourceMap };
    },
  };
}

/** Pre-built React Refresh transformer wrapping the default TypeScript transformer */
export const reactRefreshTransformer: Transformer =
  createReactRefreshTransformer(typescriptTransformer);
