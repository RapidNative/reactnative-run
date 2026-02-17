import type { BundlerPlugin } from "almostmetro";

const GLOBALS_PREAMBLE =
  "if(typeof __DEV__==='undefined')globalThis.__DEV__=true;\n" +
  "if(typeof global==='undefined')globalThis.global=globalThis;\n";

const EXPO_SHIM = [
  'var RN = require("react-native");',
  "exports.registerRootComponent = function(component) {",
  '  RN.AppRegistry.registerComponent("main", function() { return component; });',
  '  var rootTag = typeof document !== "undefined" ? document.getElementById("root") : undefined;',
  '  if (rootTag) RN.AppRegistry.runApplication("main", { rootTag: rootTag });',
  "};",
].join("\n");

const EXPO_STATUS_BAR_SHIM =
  "exports.StatusBar = function StatusBar() { return null; };";

function isJSX(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

function hasReactImport(src: string): boolean {
  return /\bimport\s+React\b/.test(src) || /\bfrom\s+['"]react['"]/.test(src);
}

export const webPlugin: BundlerPlugin = {
  name: "web",
  transformSource({ src, filename }) {
    if (isJSX(filename) && !hasReactImport(src)) {
      return { src: 'import React from "react";\n' + src };
    }
    return null;
  },
  transformOutput({ code }) {
    return { code: GLOBALS_PREAMBLE + code };
  },
  moduleAliases() {
    return { "react-native": "react-native-web" };
  },
  shimModules() {
    return {
      "expo": EXPO_SHIM,
      "expo-status-bar": EXPO_STATUS_BAR_SHIM,
    };
  },
};
