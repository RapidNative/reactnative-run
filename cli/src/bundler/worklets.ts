import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import type * as BabelCore from "@babel/core";

/**
 * react-native-reanimated support for user code.
 *
 * Reanimated requires the react-native-worklets babel plugin: it turns
 * functions marked 'worklet' (and callbacks passed to APIs like
 * useAnimatedStyle) into serializable worklet factories the UI runtime can
 * evaluate. Metro runs it via babel.config.js; our pipeline runs it in the
 * native post-sucrase babel pass (hermes-lowering).
 *
 * The plugin version must match the app's react-native-worklets runtime, so
 * it's resolved from the project's own node_modules when installed, and
 * otherwise npm-installed once into ~/.rnrun/tools/ keyed by version.
 */

/** Fast gate: only run the (slow) worklets babel pass on files that can contain worklets. */
export const WORKLET_HINT_RE =
  /['"]worklet['"]|useAnimatedStyle|useAnimatedProps|useDerivedValue|useAnimatedScrollHandler|useAnimatedReaction|useFrameCallback|useAnimatedGestureHandler|createAnimatedPropAdapter|withTiming|withSpring|withDecay|withClamp|runOnUI|runOnRuntime|useAnimatedKeyboard|useScrollViewOffset|Gesture\./;

/**
 * Worklet-API names the plugin auto-workletizes by callee name. Sucrase emits
 * named-import calls as `_mod.fn.call(void 0, args)` whose callee property is
 * "call", which the plugin doesn't recognize -- the unwrap plugin below
 * rewrites those to `(0, _mod.fn)(args)` (identical semantics) first.
 */
const WORKLET_API_NAMES = new Set([
  "useFrameCallback",
  "useAnimatedStyle",
  "useAnimatedProps",
  "createAnimatedPropAdapter",
  "useDerivedValue",
  "useAnimatedScrollHandler",
  "useAnimatedReaction",
  "useAnimatedGestureHandler",
  "withTiming",
  "withSpring",
  "withDecay",
  "withClamp",
  "withRepeat",
  "withSequence",
  "withDelay",
  "runOnUI",
  "runOnUIAsync",
  "runOnRuntime",
  "scheduleOnRuntime",
  "executeOnUIRuntimeSync",
]);

/** Babel plugin: `X.NAME.call(void 0, ...args)` -> `(0, X.NAME)(...args)` for worklet APIs. */
export function unwrapSucraseWorkletCalls({ types: t }: typeof BabelCore): BabelCore.PluginObj {
  return {
    name: "unwrap-sucrase-worklet-calls",
    visitor: {
      CallExpression(p) {
        const callee = p.node.callee;
        if (
          !t.isMemberExpression(callee) ||
          !t.isIdentifier(callee.property, { name: "call" }) ||
          !t.isMemberExpression(callee.object) ||
          !t.isIdentifier(callee.object.property)
        ) {
          return;
        }
        if (!WORKLET_API_NAMES.has(callee.object.property.name)) return;
        const [thisArg, ...rest] = p.node.arguments;
        if (!thisArg || !t.isUnaryExpression(thisArg, { operator: "void" })) return;
        p.node.callee = t.sequenceExpression([t.numericLiteral(0), callee.object]);
        p.node.arguments = rest;
      },
    },
  };
}

/**
 * Resolve the worklets babel plugin for a project, or null when the project
 * doesn't use reanimated/worklets. Resolution order: project node_modules,
 * then a cached install under ~/.rnrun/tools.
 */
export function resolveWorkletsPlugin(
  rootDir: string,
  deps: Record<string, string>,
  warn: (msg: string) => void
): string | null {
  const version = deps["react-native-worklets"];
  const hasReanimated = "react-native-reanimated" in deps;
  if (!version && !hasReanimated) return null;

  // 1. The project's own install (version-exact by construction).
  for (const spec of ["react-native-worklets/plugin", "react-native-reanimated/plugin"]) {
    try {
      return createRequire(path.join(rootDir, "package.json")).resolve(spec);
    } catch {
      /* try next */
    }
  }

  // 2. Tool cache: install the declared version once, reuse forever.
  const wanted = version ?? "latest";
  const toolDir = path.join(
    os.homedir(),
    ".rnrun",
    "tools",
    `worklets-plugin-${wanted.replace(/[^\w.-]/g, "_")}`
  );
  const probe = () => {
    try {
      return createRequire(path.join(toolDir, "package.json")).resolve("react-native-worklets/plugin");
    } catch {
      return null;
    }
  };
  let resolved = probe();
  if (!resolved) {
    try {
      warn(`[worklets] installing react-native-worklets@${wanted} babel plugin (one-time, ~10s)`);
      fs.mkdirSync(toolDir, { recursive: true });
      fs.writeFileSync(path.join(toolDir, "package.json"), JSON.stringify({ name: "rnrun-tools", version: "1.0.0" }));
      execSync(`npm install react-native-worklets@${JSON.stringify(wanted).slice(1, -1)} --no-audit --no-fund --ignore-scripts`, {
        cwd: toolDir,
        stdio: "ignore",
        timeout: 120_000,
      });
      resolved = probe();
    } catch (err) {
      warn(`[worklets] plugin install failed (${(err as Error).message}); reanimated worklets will not run. Fix: npm install in the project.`);
      return null;
    }
  }
  if (!resolved) {
    warn("[worklets] plugin not resolvable after install; reanimated worklets will not run.");
  }
  return resolved;
}
