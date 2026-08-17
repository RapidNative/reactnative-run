import { createRequire } from "node:module";
import * as babel from "@babel/core";
import type { BundlerPlugin } from "browser-metro";

const require = createRequire(import.meta.url);

/**
 * Hermes (Expo Go's engine, RN 0.81) rejects `class` syntax and async arrow
 * functions, and compiles `let`/`const` without per-iteration loop bindings
 * (verified with hermesc and on-device -- see reactnative-esm's
 * lowerClassesForHermes, which does the same for package chunks). Sucrase
 * only strips types; it never downlevels syntax, so USER code needs this
 * pass on native. Runs post-sucrase on the CJS output of local files only.
 *
 * NOTE: this rewrites the whole module, so per-module source maps for native
 * are approximate until the native source-map pipeline lands.
 */
const LOWERING_PLUGINS = [
  require.resolve("@babel/plugin-transform-classes"),
  require.resolve("@babel/plugin-transform-async-generator-functions"),
  require.resolve("@babel/plugin-transform-async-to-generator"),
  require.resolve("@babel/plugin-transform-block-scoping"),
];

const NEEDS_LOWERING = /\bclass[\s{]|\basync\b|\blet\b|\bconst\b/;

export const hermesLoweringPlugin: BundlerPlugin = {
  name: "hermes-lowering",
  transformOutput({ code, filename }: { code: string; filename: string }) {
    // Local files only; package chunks are lowered server-side.
    if (!filename.startsWith("/")) return null;
    if (!NEEDS_LOWERING.test(code)) return null;
    const result = babel.transformSync(code, {
      plugins: LOWERING_PLUGINS,
      babelrc: false,
      configFile: false,
      compact: false,
      sourceMaps: false,
      sourceType: "script",
    });
    if (result?.code == null) return null;
    return { code: result.code };
  },
};
