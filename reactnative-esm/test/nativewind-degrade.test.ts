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
    keyframes: { pulse: [{ opacity: 0.5 }] },
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
  assert.equal(n, 4, "one animations payload + one transition payload + two rule-level markers");
  assert.equal("animations" in d.rules["animate-pulse"].n[0], false);
  assert.equal("transition" in d.rules["transition-colors"].n[0], false);
  assert.deepEqual(d.keyframes, {});
  // static styling untouched
  assert.deepEqual(d.rules["flex-1"].n[0].d, [[{ flexGrow: 1 }]]);
});

test("does NOT fire for reanimated 3 (the compatible pairing)", () => {
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1", "react-native-reanimated": "3.19.0" });
  assert.equal(n, 0);
  assert.ok("animations" in d.rules["animate-pulse"].n[0], "animations preserved on rea 3");
  assert.deepEqual(d.keyframes, { pulse: [{ opacity: 0.5 }] });
});

test("does NOT fire once a newer css-interop is used", () => {
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.3.0", "react-native-reanimated": "4.1.3" });
  assert.equal(n, 0, "self-disables when css-interop moves off 0.2.x");
});

test("tolerates caret/tilde ranges and missing versions", () => {
  assert.equal(degradeIncompatibleAnimations(sample(), { "react-native-css-interop": "^0.2.1", "react-native-reanimated": "~4.1.3" }), 4);
  assert.equal(degradeIncompatibleAnimations(sample(), {}), 0);
});

test("strips when reanimated version is ABSENT (the real client historically omitted it)", () => {
  // The bug that shipped: rnrun sent only nativewind/tailwind/css-interop/rn,
  // never reanimated -- so an rea-major gate read undefined and never fired.
  // Absent must default to strip: a static skeleton beats a UI-thread SIGABRT.
  const d = sample();
  const n = degradeIncompatibleAnimations(d, { "react-native-css-interop": "0.2.1" });
  assert.equal(n, 4, "unknown reanimated -> assume incompatible -> strip payloads + markers");
  assert.deepEqual(d.keyframes, {});
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
