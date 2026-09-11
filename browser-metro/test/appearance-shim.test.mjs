import { test } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import { createExpoWebShimsPlugin } from "../dist/plugins/expo-web-shims.js";

// The `react-native` shim wraps react-native-web in a Proxy. react-native-web's
// Appearance has no setColorScheme (it only mirrors the OS media query), so an
// app with a theme setting threw "Appearance.setColorScheme is not a function"
// in the web preview while working on a device. Run the shim's source against
// a stub rnw and check the wrapper behaves like native Appearance.
function loadShim(rnwStub) {
  const src = createExpoWebShimsPlugin().shimModules()["react-native"];
  const module = { exports: {} };
  const ctx = vm.createContext({
    module,
    require: (name) => {
      if (name === "react-native-web") return rnwStub;
      throw new Error(`unexpected require: ${name}`);
    },
    console: { info() {}, error() {} },
    Proxy,
    Reflect,
  });
  vm.runInContext(src, ctx);
  return module.exports;
}

function stubRnw(osScheme = "light") {
  const osListeners = [];
  return {
    Appearance: {
      getColorScheme: () => osScheme,
      addChangeListener(l) {
        osListeners.push(l);
        return { remove: () => osListeners.splice(osListeners.indexOf(l), 1) };
      },
    },
    Alert: { alert() {} },
    View: "View",
    _emitOs(scheme) {
      osScheme = scheme;
      for (const l of osListeners) l({ colorScheme: scheme });
    },
    _osListenerCount: () => osListeners.length,
  };
}

test("setColorScheme exists and pins the scheme", () => {
  const rnw = stubRnw("light");
  const RN = loadShim(rnw);
  assert.equal(typeof RN.Appearance.setColorScheme, "function");
  assert.equal(RN.Appearance.getColorScheme(), "light", "follows the OS by default");
  RN.Appearance.setColorScheme("dark");
  assert.equal(RN.Appearance.getColorScheme(), "dark");
});

test("null and 'unspecified' clear the override (RN 0.86 'follow system' spelling)", () => {
  const rnw = stubRnw("light");
  const RN = loadShim(rnw);
  RN.Appearance.setColorScheme("dark");
  RN.Appearance.setColorScheme("unspecified");
  assert.equal(RN.Appearance.getColorScheme(), "light");
  RN.Appearance.setColorScheme("dark");
  RN.Appearance.setColorScheme(null);
  assert.equal(RN.Appearance.getColorScheme(), "light");
});

test("listeners hear override changes and OS changes, and can be removed", () => {
  const rnw = stubRnw("light");
  const RN = loadShim(rnw);
  const seen = [];
  const sub = RN.Appearance.addChangeListener((e) => seen.push(e.colorScheme));
  RN.Appearance.setColorScheme("dark");
  assert.deepEqual(seen, ["dark"], "override change notifies");
  rnw._emitOs("light");
  assert.deepEqual(seen, ["dark"], "OS change is masked while an override is pinned");
  RN.Appearance.setColorScheme(null);
  assert.deepEqual(seen, ["dark", "light"], "clearing the override notifies with the OS scheme");
  rnw._emitOs("dark");
  assert.deepEqual(seen, ["dark", "light", "dark"], "OS changes pass through when unpinned");
  sub.remove();
  RN.Appearance.setColorScheme("light");
  assert.deepEqual(seen, ["dark", "light", "dark"], "removed listener is silent");
  assert.equal(rnw._osListenerCount(), 0, "the OS subscription is released too");
});

test("everything else on react-native-web still passes through, Alert stays shimmed", () => {
  const RN = loadShim(stubRnw());
  assert.equal(RN.View, "View");
  assert.equal(typeof RN.Alert.prompt, "function", "Alert shim (prompt) still active");
});
