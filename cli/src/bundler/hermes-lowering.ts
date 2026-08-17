import { createRequire } from "node:module";
import * as babel from "@babel/core";
import type { BundlerPlugin } from "browser-metro";
import { unwrapSucraseWorkletCalls, WORKLET_HINT_RE } from "./worklets.js";

const require = createRequire(import.meta.url);

/**
 * Hermes (Expo Go's engine, RN 0.81) rejects `class` syntax and async arrow
 * functions, and compiles `let`/`const` without per-iteration loop bindings
 * (verified with hermesc and on-device -- see reactnative-esm's
 * lowerClassesForHermes, which does the same for package chunks). Sucrase
 * only strips types; it never downlevels syntax, so USER code needs this
 * pass on native. Runs post-sucrase on the CJS output of local files only.
 *
 * When the project uses reanimated, the same pass also runs the
 * react-native-worklets babel plugin (worklet factories must be generated
 * BEFORE class/block-scoping lowering mangles the functions it matches),
 * preceded by the sucrase-interop unwrap so auto-workletized callees are
 * recognizable.
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

export function createHermesLoweringPlugin(options: { workletsPluginPath?: string | null } = {}): BundlerPlugin {
  const workletsPlugin = options.workletsPluginPath ?? null;
  return {
    name: "hermes-lowering",
    transformOutput({ code, filename }: { code: string; filename: string }) {
      // Local files only; package chunks are lowered server-side.
      if (!filename.startsWith("/")) return null;
      const wantsWorklets = workletsPlugin !== null && WORKLET_HINT_RE.test(code);
      if (!wantsWorklets && !NEEDS_LOWERING.test(code)) return null;
      const result = babel.transformSync(code, {
        plugins: [
          // disableSourceMaps: the plugin otherwise fs-reads state.filename to
          // embed sourcesContent -- our filenames are VFS paths, not disk paths.
          ...(wantsWorklets ? [unwrapSucraseWorkletCalls, [workletsPlugin, { disableSourceMaps: true }]] : []),
          ...LOWERING_PLUGINS,
        ],
        babelrc: false,
        configFile: false,
        compact: false,
        sourceMaps: false,
        sourceType: "script",
        filename,
      });
      if (result?.code == null) return null;
      return { code: result.code };
    },
  };
}

/** Back-compat export: lowering only, no worklets pass. */
export const hermesLoweringPlugin: BundlerPlugin = createHermesLoweringPlugin();
