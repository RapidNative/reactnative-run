import type { BundlerPlugin } from "almostmetro";

const GLOBALS_PREAMBLE =
  "if(typeof __DEV__==='undefined')globalThis.__DEV__=true;\n" +
  "if(typeof global==='undefined')globalThis.global=globalThis;\n";

/**
 * Shim module that monkey-patches React.createElement so that any `className`
 * prop is converted to a react-native-web $$css style object.  RNW then
 * outputs the raw class names as a DOM `class` attribute, which Tailwind CDN
 * can match.
 */
const CLASSNAME_PATCH_MODULE = `
var React = require("react");
var _orig = React.createElement;

// Extract __cssVars from a style prop (could be object, array, or nested)
function _extractCssVars(style) {
  if (!style) return null;
  if (style.__cssVars) return style.__cssVars;
  if (Array.isArray(style)) {
    for (var i = 0; i < style.length; i++) {
      var v = _extractCssVars(style[i]);
      if (v) return v;
    }
  }
  return null;
}

// Remove __cssVars objects from style to prevent RNW from processing them
function _cleanStyle(style) {
  if (!style) return style;
  if (style.__cssVars) return undefined;
  if (Array.isArray(style)) {
    return style.filter(function(s) { return !s || !s.__cssVars; });
  }
  return style;
}

React.createElement = function() {
  var args = Array.prototype.slice.call(arguments);
  var type = args[0];
  var props = args[1];

  if (props && typeof type !== "string") {
    var needsClone = false;

    // Handle className -> $$css conversion
    if (typeof props.className === "string" && props.className) {
      needsClone = true;
    }

    // Handle __cssVars in style
    var cssVars = _extractCssVars(props.style);
    if (cssVars) {
      needsClone = true;
    }

    if (needsClone) {
      props = Object.assign({}, props);

      if (typeof props.className === "string" && props.className) {
        var cn = props.className;
        var cssObj = { $$css: true };
        cn.split(/\\s+/).forEach(function(c) { if (c) cssObj[c] = c; });
        var cleanedStyle = _cleanStyle(props.style);
        if (cleanedStyle) {
          props.style = Array.isArray(cleanedStyle)
            ? [cssObj].concat(cleanedStyle)
            : [cssObj, cleanedStyle];
        } else {
          props.style = cssObj;
        }
        delete props.className;
      }

      // If there are CSS variables, inject a ref to apply them to the DOM element
      if (cssVars) {
        if (!props.style || props.style.__cssVars) {
          props.style = undefined;
        }
        var existingRef = props.ref;
        var vars = cssVars;
        props.ref = function(el) {
          if (el && el.style) {
            for (var k in vars) {
              if (vars.hasOwnProperty(k)) {
                el.style.setProperty(k, vars[k]);
              }
            }
          }
          // Call existing ref if any
          if (typeof existingRef === "function") existingRef(el);
          else if (existingRef && typeof existingRef === "object") existingRef.current = el;
        };
      }

      args[1] = props;
    }
  }
  return _orig.apply(this, args);
};
module.exports = {};
`;

/**
 * Nativewind shim: provides useColorScheme and vars for web.
 */
const NATIVEWIND_SHIM = `
var React = require("react");
var RN = require("react-native");

var _listeners = new Set();
var _userPref = null;

function _getSystemScheme() {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function _getEffective() {
  return (_userPref === "system" || _userPref === null) ? _getSystemScheme() : _userPref;
}

if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {
    if (_userPref === "system" || _userPref === null) {
      _listeners.forEach(function(l) { l(_getEffective()); });
    }
  });
}

exports.useColorScheme = function useColorScheme() {
  var _s = React.useState(function() { return _getEffective(); });
  var colorScheme = _s[0], setCS = _s[1];

  React.useEffect(function() {
    var listener = function(s) { setCS(s); };
    _listeners.add(listener);
    return function() { _listeners.delete(listener); };
  }, []);

  return {
    colorScheme: colorScheme,
    setColorScheme: function(scheme) {
      _userPref = scheme;
      var eff = scheme === "system" ? _getSystemScheme() : scheme;
      setCS(eff);
      _listeners.forEach(function(l) { l(eff); });
    },
    toggleColorScheme: function() {
      var next = colorScheme === "dark" ? "light" : "dark";
      _userPref = next;
      setCS(next);
      _listeners.forEach(function(l) { l(next); });
    }
  };
};

exports.vars = function vars(obj) {
  // Mark the object so our createElement patch can identify it
  // and apply CSS custom properties directly to the DOM element
  var result = {};
  result.__cssVars = obj;
  return result;
};
`;

/**
 * Expo web plugin:
 * - Aliases react-native → react-native-web
 * - Injects __DEV__ and global for react-native-web compatibility
 * - Auto-injects React import for JSX files
 * - Patches React.createElement to pass className as $$css style
 * - Shims nativewind for web (useColorScheme, vars)
 */
function isJSX(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

function hasReactImport(src: string): boolean {
  return /\bimport\s+React\b/.test(src) || /\bimport\s+\*\s+as\s+React\b/.test(src);
}

export const expoWebPlugin: BundlerPlugin = {
  name: "expo-web",
  transformSource({ src, filename }) {
    let modified = src;
    let changed = false;

    // Auto-inject React import for JSX files
    if (isJSX(filename) && !hasReactImport(src)) {
      modified = 'import React from "react";\n' + modified;
      changed = true;
    }

    // Inject className patch at the top of the entry file so it runs first
    if (filename === "/index.tsx" || filename === "/index.ts" || filename === "/index.js") {
      modified = 'require("__classname-patch__");\n' + modified;
      changed = true;
    }

    return changed ? { src: modified } : null;
  },
  transformOutput({ code }) {
    return { code: GLOBALS_PREAMBLE + code };
  },
  moduleAliases() {
    return { "react-native": "react-native-web" };
  },
  shimModules() {
    return {
      "__classname-patch__": CLASSNAME_PATCH_MODULE,
      nativewind: NATIVEWIND_SHIM,
      "react-native-css-interop": "module.exports = {};",
    };
  },
};
