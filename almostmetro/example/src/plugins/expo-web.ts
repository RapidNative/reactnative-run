import type { BundlerPlugin } from "almostmetro";

const GLOBALS_PREAMBLE =
  "if(typeof __DEV__==='undefined')globalThis.__DEV__=true;\n" +
  "if(typeof global==='undefined')globalThis.global=globalThis;\n";

/**
 * Expo web plugin:
 * - Aliases react-native → react-native-web
 * - Injects __DEV__ and global for react-native-web compatibility
 * - Auto-injects React import for JSX files
 */
function isJSX(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

function hasReactImport(src: string): boolean {
  // Check for default import: `import React from 'react'` or `import React, { ... } from 'react'`
  // Also matches `import * as React from 'react'`
  return /\bimport\s+React\b/.test(src) || /\bimport\s+\*\s+as\s+React\b/.test(src);
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
};
