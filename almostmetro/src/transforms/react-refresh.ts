import { countNewlines } from "../source-map.js";
import { Transformer } from "../types.js";
import { typescriptTransformer } from "./typescript.js";

function isJsxFile(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
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

      // Check if module uses createContext (needs HMR identity preservation)
      const usesCreateContext =
        params.src.includes('createContext') || result.code.includes('createContext');

      // Preamble: set up refresh hooks scoped to this module
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

      // Context identity preservation: patch React.createContext so re-executions
      // return the same context object, preventing useContext identity mismatches
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
          '  $RefreshReg$(' + name + ', ' + JSON.stringify(name) + ');\n' +
          '}\n';
      }
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
