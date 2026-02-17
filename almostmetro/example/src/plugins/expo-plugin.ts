import type { BundlerPlugin } from "almostmetro";

function isJSX(filename: string): boolean {
  return filename.endsWith(".tsx") || filename.endsWith(".jsx");
}

function hasReactImport(src: string): boolean {
  return /\bimport\s+React\b/.test(src) || /\bfrom\s+['"]react['"]/.test(src);
}

export const expoPlugin: BundlerPlugin = {
  name: "expo",
  transformSource({ src, filename }) {
    if (isJSX(filename) && !hasReactImport(src)) {
      return { src: 'import React from "react";\n' + src };
    }
    return null;
  },
};
