import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHermesLoweringPlugin } from "../dist/bundler/hermes-lowering.js";

// react-native-worklets 0.13 (Expo SDK 58) chooses what to workletize while it
// scans the program, before any sibling plugin's visitors run. When the sucrase
// unwrap shared its pass, the plugin still saw `_mod.useAnimatedStyle.call(void 0,
// cb)` and left `cb` a plain function; Expo Go 58 then threw "[Worklets] Tried
// to synchronously call a Remote Function" on the first animated style. The
// unwrap now runs as its own pass, so the plugin's early scan sees unwrapped
// calls. This fake plugin records what it sees at scan time.
const FAKE_PLUGIN = `
module.exports = function (babel) {
  const t = babel.types;
  return {
    name: "fake-worklets",
    pre(file) {
      const seen = [];
      file.path.traverse({
        CallExpression(p) {
          const c = p.node.callee;
          // Only worklet APIs are unwrapped (useSharedValue keeps sucrase's .call form, which is fine).
          if (
            t.isMemberExpression(c) &&
            t.isIdentifier(c.property, { name: "call" }) &&
            t.isMemberExpression(c.object) &&
            t.isIdentifier(c.object.property, { name: "useAnimatedStyle" })
          ) {
            seen.push("call-shape");
          }
          if (t.isSequenceExpression(c)) seen.push("unwrapped");
        },
      });
      globalThis.__fakeWorkletsSeen = seen;
    },
    visitor: {},
  };
};
`;

const SUCRASE_SHAPE = [
  'var _reactnativereanimated = require("react-native-reanimated");',
  "function Button() {",
  "  const scale = _reactnativereanimated.useSharedValue.call(void 0, 1);",
  "  const animatedStyle = _reactnativereanimated.useAnimatedStyle.call(void 0, () => ({ transform: [{ scale: scale.value }] }));",
  "  return animatedStyle;",
  "}",
].join("\n");

test("the worklets plugin sees unwrapped calls when it scans the program", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnrun-worklets-"));
  const pluginPath = path.join(dir, "fake-worklets-plugin.cjs");
  fs.writeFileSync(pluginPath, FAKE_PLUGIN);
  const plugin = createHermesLoweringPlugin({ workletsPluginPath: pluginPath });
  globalThis.__fakeWorkletsSeen = null;
  const out = plugin.transformOutput({ code: SUCRASE_SHAPE, filename: "/src/components/Button.tsx" });
  assert.ok(out && out.code, "transformOutput returns code");
  const seen = globalThis.__fakeWorkletsSeen;
  assert.ok(Array.isArray(seen), "the plugin ran its program scan");
  assert.ok(!seen.includes("call-shape"), "no `.call(void 0, ...)` worklet call reached the plugin's scan");
  assert.ok(seen.includes("unwrapped"), "the unwrapped `(0, _mod.fn)(...)` shape reached the plugin's scan");
  assert.match(out.code, /\(0, _reactnativereanimated\.useAnimatedStyle\)\(/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("files without worklet hints skip the unwrap pass entirely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rnrun-worklets-"));
  const pluginPath = path.join(dir, "fake-worklets-plugin.cjs");
  fs.writeFileSync(pluginPath, FAKE_PLUGIN);
  const plugin = createHermesLoweringPlugin({ workletsPluginPath: pluginPath });
  globalThis.__fakeWorkletsSeen = null;
  const out = plugin.transformOutput({ code: "const x = 1;\nclass A {}", filename: "/src/a.tsx" });
  assert.ok(out && out.code);
  assert.strictEqual(globalThis.__fakeWorkletsSeen, null, "the worklets plugin did not run");
  fs.rmSync(dir, { recursive: true, force: true });
});
