// The css-interop 0.2.x + reanimated >=4 pairing crashes Expo Go on native
// (a CSS-animation worklet throws on the UI runtime -> SIGABRT). The server
// degrades animations/transitions to static for exactly that pairing. These
// pin: it fires only for the incompatible combo, strips the crash triggers,
// and leaves static declarations untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { degradeIncompatibleAnimations } from "../src/output";

function sample() {
  return {
    keyframes: [["pulse", { frames: [["opacity", [{ value: 0.5, progress: 0 }]]] }]],
    rules: {
      "flex-1": { n: [{ s: [3, 1], d: [[{ flexGrow: 1 }]] }] },
      "animate-pulse": { animation: true, n: [{ s: [4, 1], d: [], animations: { name: [{ type: "ident", value: "pulse" }] } }] },
      "transition-colors": { animation: true, n: [{ s: [5, 1], d: [], transition: { property: ["color"] } }] },
    },
  };
}

test("strips animations/transitions/keyframes for css-interop 0.2.x + reanimated 4", () => {
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1", "react-native-reanimated": "4.1.3" });
  assert.equal(n, 5, "2 payloads + 2 markers + 1 keyframes delete");
  assert.equal("animations" in d.rules["animate-pulse"].n[0], false);
  assert.equal("transition" in d.rules["transition-colors"].n[0], false);
  assert.equal("keyframes" in d, false, "keyframes deleted, not clobbered to a non-iterable object");
  // static styling untouched
  assert.deepEqual(d.rules["flex-1"].n[0].d, [[{ flexGrow: 1 }]]);
});

test("does NOT fire for reanimated 3 (the compatible pairing)", () => {
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1", "react-native-reanimated": "3.19.0" });
  assert.equal(n, 0);
  assert.ok("animations" in d.rules["animate-pulse"].n[0], "animations preserved on rea 3");
  assert.deepEqual(d.keyframes, [["pulse", { frames: [["opacity", [{ value: 0.5, progress: 0 }]]] }]]);
});

test("does NOT fire once a newer css-interop is used", () => {
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.3.0", "react-native-reanimated": "4.1.3" });
  assert.equal(n, 0, "self-disables when css-interop moves off 0.2.x");
});

test("tolerates caret/tilde ranges and missing versions", () => {
  assert.equal(degradeIncompatibleAnimations(sample(), { "react-native-css-interop": "^0.2.1", "react-native-reanimated": "~4.1.3" }), 5);
  assert.equal(degradeIncompatibleAnimations(sample(), {}), 0);
});

test("strips when reanimated version is ABSENT (the real client historically omitted it)", () => {
  // The bug that shipped: rnrun sent only nativewind/tailwind/css-interop/rn,
  // never reanimated -- so an rea-major gate read undefined and never fired.
  // Absent must default to strip: a static skeleton beats a UI-thread SIGABRT.
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1" });
  assert.equal(n, 5, "unknown reanimated -> strip payloads + markers + keyframes");
  assert.equal("keyframes" in d, false, "keyframes deleted, not clobbered to a non-iterable object");
});

test("removes the rule-level `animation: true` marker (half-strip -> redbox otherwise)", () => {
  const d = sample();
  degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1", "react-native-reanimated": "4.1.3" });
  // A degraded rule must be shaped EXACTLY like a static rule: {n:[{s,d}]},
  // no leftover `animation` marker and no payload. That empty-but-flagged
  // shape is the "iterator method is not callable" redbox signature.
  assert.equal("animation" in d.rules["animate-pulse"], false, "animate-pulse marker cleared");
  assert.equal("animation" in d.rules["transition-colors"], false, "transition marker cleared");
  assert.deepEqual(Object.keys(d.rules["animate-pulse"].n[0]).sort(), ["d", "s"]);
  assert.deepEqual(Object.keys(d.rules["transition-colors"].n[0]).sort(), ["d", "s"]);
});

test("degraded keyframes never becomes a non-iterable object (injectData for..of contract)", () => {
  const d = sample();
  degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1", "react-native-reanimated": "4.1.3" });
  // Replicate exactly what css-interop's injectData does; must not throw.
  const kf = (d as { keyframes?: unknown }).keyframes;
  assert.doesNotThrow(() => {
    if (kf) { for (const entry of kf as Iterable<unknown>) void entry; }
  }, "keyframes must be absent or an iterable array, never a plain object");
});

// ---------------------------------------------------------------------------
// Runtime-contract guards. Every miss in the four-round animate-pulse crash
// was "verified a constructed shape, not the real runtime": the gate that
// never fired on the real request (no reanimated version), and three strips
// that each left a shape css-interop's runtime still tripped on. These pin the
// two real contracts against a REAL captured request shape and a faithful
// replica of css-interop 0.2.1's injectData + collectRules.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __d = dirname(fileURLToPath(import.meta.url));

test("gate FIRES on the real captured client request shape (no reanimated version)", () => {
  // Captured from the actual rnrun /nativewind-css POST via a logging proxy.
  // The fleet client sends nativewind/tailwind/css-interop/react-native and
  // NOT reanimated -- the exact shape the first gate silently no-op'd on.
  const fixture = JSON.parse(readFileSync(join(__d, "fixtures/real-nativewind-request.json"), "utf8"));
  const data = {
    keyframes: [["pulse", { frames: [["opacity", [{ value: 0.5, progress: 0 }]]] }]],
    rules: { "animate-pulse": { animation: true, n: [{ s: [1, 1], d: [], animations: { name: [{ type: "ident", value: "pulse" }] } }] } },
  };
  const n = degradeIncompatibleAnimations(data, fixture.versions);
  assert.ok(n > 0, "the real fleet request (css-interop 0.2.1, reanimated absent) MUST trigger the degrade");
});

test("degraded output survives css-interop's injectData + collectRules (no throw, no animation path)", () => {
  // Faithful replicas of css-interop 0.2.1 runtime/native: styles.injectData
  // (iterates keyframes as an array of pairs) and native-interop.collectRules
  // (enters the animation path when a variant has `animations`/`transition`).
  const data: any = {
    keyframes: [["pulse", { frames: [["opacity", [{ value: 0.5, progress: 0 }]]] }]],
    rules: {
      "animate-pulse": { animation: true, n: [{ s: [1, 1], d: [], animations: { name: [{ type: "ident", value: "pulse" }] } }] },
      "transition-colors": { animation: true, n: [{ s: [2, 1], d: [], transition: { property: ["color"] } }] },
      "flex-1": { n: [{ s: [3, 1], d: [[{ flexGrow: 1 }]] }] },
    },
  };
  degradeIncompatibleAnimations(data, { "react-native-css-interop": "0.2.1", "react-native-reanimated": "4.1.3" });

  // injectData keyframes loop -- the #63/#64/#65 throw site.
  assert.doesNotThrow(() => {
    if (data.keyframes) for (const entry of data.keyframes) void (entry as unknown[])[0];
  }, "injectData for..of over keyframes must not throw (keyframes absent or an array)");

  // collectRules animation-path trigger.
  let entersAnimationPath = false;
  for (const rule of Object.values<any>(data.rules)) {
    for (const variant of rule.n ?? []) if (variant.animations || variant.transition) entersAnimationPath = true;
    if (rule.animation) entersAnimationPath = true;
  }
  assert.equal(entersAnimationPath, false, "no rule may retain an animation/transition trigger");

  // static styling preserved.
  assert.deepEqual(data.rules["flex-1"].n[0].d, [[{ flexGrow: 1 }]]);
});
