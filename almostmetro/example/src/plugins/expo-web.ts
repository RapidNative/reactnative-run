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
  // Native module stubs -- these don't exist on web, return safe no-ops
  "exports.requireOptionalNativeModule = function() { return null; };",
  "exports.requireNativeModule = function() { return {}; };",
  "exports.requireNativeView = function() { return null; };",
  // SharedRef base class used by expo-image and others
  "exports.SharedRef = class SharedRef {};",
].join("\n");

const EXPO_STATUS_BAR_SHIM =
  "exports.StatusBar = function StatusBar() { return null; };";

const EXPO_ROUTER_SHIM = [
  'var React = require("react");',
  "var noop = function() { return null; };",
  "var NoopComponent = function(props) { return props.children || null; };",
  "NoopComponent.Screen = NoopComponent;",
  "function makeNavigator() { var Nav = function(props) { return props.children || null; }; Nav.Screen = NoopComponent; Nav.Group = NoopComponent; return Nav; }",
  "exports.Stack = makeNavigator();",
  "exports.Tabs = makeNavigator();",
  "var LinkComponent = function(props) { return props.children || null; };",
  "LinkComponent.Trigger = NoopComponent;",
  "LinkComponent.Preview = NoopComponent;",
  "LinkComponent.Menu = NoopComponent;",
  "LinkComponent.MenuAction = NoopComponent;",
  "exports.Link = LinkComponent;",
  "exports.Slot = NoopComponent;",
  "exports.useRouter = function() { return { push: noop, replace: noop, back: noop, canGoBack: function() { return false; } }; };",
  "exports.useLocalSearchParams = function() { return {}; };",
  "exports.useGlobalSearchParams = function() { return {}; };",
  "exports.useSegments = function() { return []; };",
  "exports.usePathname = function() { return '/'; };",
  "exports.router = { push: noop, replace: noop, back: noop, canGoBack: function() { return false; } };",
].join("\n");

/**
 * Expo web plugin:
 * - Aliases react-native → react-native-web
 * - Shims expo (registerRootComponent) and expo-status-bar (no-op)
 * - Injects __DEV__ and global for react-native-web compatibility
 */
function isJSX(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

function hasReactImport(src: string): boolean {
  if (/\bimport\s+React\b/.test(src)) return true;
  // Match `from 'react'` but not type-only imports (import type { ... } from 'react')
  const reactImports = src.match(/\bimport\s+(.+?)\s+from\s+['"]react['"]/g);
  if (!reactImports) return false;
  return reactImports.some(m => !/\bimport\s+type\b/.test(m));
}

export const expoWebPlugin: BundlerPlugin = {
  name: "expo-web",
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
      "expo-router": EXPO_ROUTER_SHIM,
    };
  },
};
