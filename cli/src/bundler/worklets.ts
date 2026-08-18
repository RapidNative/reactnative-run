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

  // 0. Explicit override, checked first: a host that bakes the plugin into an
  // image points at it directly and no fetch ever happens -- which also keeps
  // the fetch off the startup path, where wake latency lives.
  const override = process.env.RNRUN_WORKLETS_PLUGIN;
  if (override) {
    try {
      createRequire(import.meta.url)(override);
      return override;
    } catch (err) {
      warn(
        `[worklets] RNRUN_WORKLETS_PLUGIN=${override} could not be loaded (${(err as Error).message}); ` +
          `falling back to resolution`
      );
    }
  }

  // 1. The project's own install (version-exact by construction).
  for (const spec of ["react-native-worklets/plugin", "react-native-reanimated/plugin"]) {
    try {
      return createRequire(path.join(rootDir, "package.json")).resolve(spec);
    } catch {
      /* try next */
    }
  }

  // 2. Tool cache: fetch the plugin once per version, reuse forever.
  //
  // Deliberately NOT `npm install react-native-worklets`: that pulls 256
  // transitive packages (~140MB) plus ~200MB of npm HTTP cache, none of it
  // needed. The plugin ships pre-bundled (~1.6MB) and its only runtime imports
  // are @babel/* and convert-source-map, which rnrun already depends on -- so
  // fetch just the tarball and point the plugin at our own module tree. On a
  // container-per-project host this was the single largest per-project cost,
  // larger than the project itself, and it sat on the startup path.
  //
  // RNRUN_TOOLS_DIR relocates the cache so a host can bake it into an image or
  // share one copy across containers instead of paying for it per container.
  const wanted = version ?? "latest";
  const toolsRoot = process.env.RNRUN_TOOLS_DIR || path.join(os.homedir(), ".rnrun", "tools");
  const toolDir = path.join(toolsRoot, `worklets-${wanted.replace(/[^\w.-]/g, "_")}`);
  const pluginDir = path.join(toolDir, "react-native-worklets", "plugin");

  /** Resolve AND load: a path that exists but throws inside babel is worse
   *  than no plugin at all (that trap cost us a silently unworkletized
   *  reanimated chunk server-side). */
  const loadable = (): string | null => {
    try {
      createRequire(import.meta.url)(pluginDir);
      return pluginDir;
    } catch {
      return null;
    }
  };

  const ready = loadable();
  if (ready) return ready;

  // The plugin resolves its imports relative to its OWN location, so it needs a
  // node_modules beside it. Earlier this symlinked the directory containing our
  // @babel/core -- which assumed such a directory exists. Under `npm install -g`
  // it doesn't (the global layout has no node_modules parent to point at), so
  // both this and the fallback install failed and reanimated was silently
  // disabled in every bundle. Reported from production after a fleet rollback.
  //
  // Now nothing is guessed: each module the plugin needs is resolved from OUR
  // context and symlinked individually, so global, local, hoisted and nested
  // layouts all work.
  const PLUGIN_RUNTIME_DEPS = [
    "@babel/core",
    "@babel/generator",
    "@babel/traverse",
    "@babel/types",
    "@babel/preset-typescript",
    "@babel/plugin-transform-arrow-functions",
    "@babel/plugin-transform-nullish-coalescing-operator",
    "@babel/plugin-transform-optional-chaining",
    "@babel/plugin-transform-shorthand-properties",
    "@babel/plugin-transform-template-literals",
    "convert-source-map",
  ];

  /** Directory of an installed package, found via its package.json. */
  const packageDir = (name: string): string | null => {
    try {
      return path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
    } catch {
      try {
        // Packages without an exports entry for package.json: walk up from main.
        const main = createRequire(import.meta.url).resolve(name);
        let dir = path.dirname(main);
        for (let i = 0; i < 6; i++) {
          if (fs.existsSync(path.join(dir, "package.json"))) return dir;
          dir = path.dirname(dir);
        }
      } catch {
        /* unresolvable */
      }
      return null;
    }
  };

  const linkRuntimeDeps = (): string[] => {
    const missing: string[] = [];
    const nmDir = path.join(toolDir, "node_modules");
    for (const dep of PLUGIN_RUNTIME_DEPS) {
      const target = packageDir(dep);
      if (!target) {
        missing.push(dep);
        continue;
      }
      const linkPath = path.join(nmDir, dep);
      try {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.rmSync(linkPath, { recursive: true, force: true });
        fs.symlinkSync(target, linkPath, "junction");
      } catch (err) {
        missing.push(`${dep} (${(err as Error).message})`);
      }
    }
    return missing;
  };

  try {
    warn(`[worklets] fetching react-native-worklets@${wanted} babel plugin (one-time, ~1.6MB)`);
    fs.rmSync(toolDir, { recursive: true, force: true });
    fs.mkdirSync(toolDir, { recursive: true });
    // Scoped npm cache, discarded below: npm's _cacache otherwise leaves
    // ~200MB of tarballs and metadata behind that is never read again. Never
    // `npm cache clean` here -- that would wipe the user's global cache.
    const npmCache = path.join(toolDir, ".npm-cache");
    const tgzName = execSync(
      `npm pack react-native-worklets@${JSON.stringify(wanted).slice(1, -1)} --silent --cache ${JSON.stringify(npmCache)}`,
      { cwd: toolDir, timeout: 120_000, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" }, encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .pop()!;
    execSync(`tar -xzf ${JSON.stringify(tgzName)}`, { cwd: toolDir, timeout: 60_000 });
    fs.renameSync(path.join(toolDir, "package"), path.join(toolDir, "react-native-worklets"));
    fs.rmSync(path.join(toolDir, tgzName), { force: true });
    fs.rmSync(npmCache, { recursive: true, force: true });

    const missing = linkRuntimeDeps();
    const ok = loadable();
    if (ok) return ok;
    warn(
      `[worklets] fetched plugin did not load` +
        (missing.length ? ` (could not link: ${missing.join(", ")})` : "") +
        `; falling back to a full install`
    );
    return legacyInstall(toolDir, wanted, warn);
  } catch (err) {
    warn(`[worklets] plugin fetch failed (${(err as Error).message}); falling back to a full install`);
    return legacyInstall(toolDir, wanted, warn);
  }
}

/** The pre-existing behaviour: a real install, dependency tree and all. Kept as
 *  a fallback for layouts where the lean path can't work. */
function legacyInstall(toolDir: string, wanted: string, warn: (msg: string) => void): string | null {
  try {
    fs.mkdirSync(toolDir, { recursive: true });
    fs.writeFileSync(path.join(toolDir, "package.json"), JSON.stringify({ name: "rnrun-tools", version: "1.0.0" }));
    execSync(
      `npm install react-native-worklets@${JSON.stringify(wanted).slice(1, -1)} --no-audit --no-fund --ignore-scripts`,
      { cwd: toolDir, stdio: "ignore", timeout: 180_000, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" } }
    );
    const resolved = createRequire(path.join(toolDir, "package.json")).resolve("react-native-worklets/plugin");
    // Load it: resolving proves a path exists, not that babel can use it.
    createRequire(import.meta.url)(resolved);
    return resolved;
  } catch (err) {
    warn(
      `[worklets] plugin install failed (${(err as Error).message}); reanimated worklets will not run. ` +
        `Fix: run npm install in the project so its own copy is used.`
    );
    return null;
  }
}
