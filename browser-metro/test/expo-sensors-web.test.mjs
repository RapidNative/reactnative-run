import { test } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import { createExpoWebShimsPlugin } from "../dist/plugins/expo-web-shims.js";
import { IncrementalBundler, VirtualFS, typescriptTransformer } from "../dist/index.js";

// expo-sensors >= 57: DeviceSensor.addListener calls this._nativeModule.addListener,
// but the web modules are plain objects that emit on DeviceEventEmitter, so on web
// every Accelerometer.addListener threw "this._nativeModule.addListener is not a
// function". The expo-web-shims override gives each web module the methods
// DeviceSensor calls. Shaped after expo-sensors 57.0.3's build output.

class DeviceSensor {
  constructor(nativeModule, eventName) {
    this._nativeModule = nativeModule;
    this._nativeEventName = eventName;
  }
  addListener(listener) {
    return this._nativeModule.addListener(this._nativeEventName, listener);
  }
  getListenerCount() {
    return this._nativeModule.listenerCount(this._nativeEventName);
  }
  removeAllListeners() {
    this._nativeModule.removeAllListeners(this._nativeEventName);
  }
}

function fakeEmitter() {
  const listeners = new Map();
  return {
    addListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return { remove: () => listeners.get(name).delete(fn) };
    },
    emit(name, value) {
      for (const fn of listeners.get(name) ?? []) fn(value);
    },
    removeAllListeners(name) {
      listeners.delete(name);
    },
  };
}

function fakeSensors() {
  const calls = { start: 0, stop: 0 };
  const accelerometerWeb = {
    isAvailableAsync: async () => true,
    startObserving() {
      calls.start++;
    },
    stopObserving() {
      calls.stop++;
    },
  };
  return {
    calls,
    sensors: {
      Accelerometer: new DeviceSensor(accelerometerWeb, "accelerometerDidUpdate"),
      // Web stubs with no observation at all (expo's barometer/light sensor on web).
      Barometer: new DeviceSensor({ isAvailableAsync: async () => false }, "barometerDidUpdate"),
    },
  };
}

function loadOverride(sensors, emitter) {
  const src = createExpoWebShimsPlugin().overrideModules()["expo-sensors"];
  const module = { exports: {} };
  const ctx = vm.createContext({
    module,
    require: (name) => {
      if (name === "expo-sensors__original") return sensors;
      if (name === "react-native") return { DeviceEventEmitter: emitter };
      throw new Error(`unexpected require: ${name}`);
    },
  });
  vm.runInContext(src, ctx);
  return module.exports;
}

test("without the override, subscribing to a sensor on web throws (the bug)", () => {
  const { sensors } = fakeSensors();
  assert.throws(() => sensors.Accelerometer.addListener(() => {}), /addListener is not a function/);
});

test("with the override, readings reach listeners and observation follows the listeners", () => {
  const { sensors, calls } = fakeSensors();
  const emitter = fakeEmitter();
  const { Accelerometer } = loadOverride(sensors, emitter);

  const seen = [];
  const a = Accelerometer.addListener((r) => seen.push(r.x));
  const b = Accelerometer.addListener(() => {});
  assert.equal(calls.start, 1, "the first listener starts observing, the second does not");
  assert.equal(Accelerometer.getListenerCount(), 2);

  emitter.emit("accelerometerDidUpdate", { x: 0.4 });
  assert.deepEqual(seen, [0.4]);

  a.remove();
  a.remove();
  assert.equal(calls.stop, 0, "still observing while a listener remains; a double remove is a no-op");
  b.remove();
  assert.equal(calls.stop, 1, "the last listener stops observing");
  emitter.emit("accelerometerDidUpdate", { x: 0.9 });
  assert.deepEqual(seen, [0.4], "removed listeners hear nothing");

  Accelerometer.addListener(() => {});
  Accelerometer.removeAllListeners();
  assert.equal(calls.start, 2);
  assert.equal(calls.stop, 2, "removeAllListeners stops observing too");
  assert.equal(Accelerometer.getListenerCount(), 0);
});

test("a sensor with no web support can be subscribed to and never emits", () => {
  const { sensors } = fakeSensors();
  const { Barometer } = loadOverride(sensors, fakeEmitter());
  const sub = Barometer.addListener(() => assert.fail("a stub sensor must not emit"));
  sub.remove();
});

test("a module that already has addListener (native, or a fixed upstream) is left alone", () => {
  const own = () => ({ remove() {} });
  const nativeModule = { addListener: own, listenerCount: () => 7, removeAllListeners() {} };
  const sensors = { Gyroscope: new DeviceSensor(nativeModule, "gyroscopeDidUpdate") };
  const { Gyroscope } = loadOverride(sensors, fakeEmitter());
  assert.equal(Gyroscope._nativeModule.addListener, own);
  assert.equal(Gyroscope.getListenerCount(), 7);
});

// The override is registered for every web build, but must only wrap a package the
// project actually fetched: otherwise "expo-sensors__original" lands in every bundle
// and the transitive pass tries to fetch it as a package.
function bundlerFor(files, requested) {
  const vfs = new VirtualFS(
    Object.fromEntries(Object.entries(files).map(([p, content]) => [p, { content, isExternal: false }]))
  );
  const fakeFetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/bundle-deps")) return new Response("// nope", { status: 404 });
    return new Response("// Bundled\nmodule.exports = {};", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  return new IncrementalBundler(vfs, {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
    plugins: [createExpoWebShimsPlugin()],
  });
}

test("a project without expo-sensors gets no override and fetches nothing extra", async () => {
  const requested = [];
  const result = await bundlerFor(
    {
      "/package.json": JSON.stringify({ name: "t", version: "1.0.0", dependencies: { "some-lib": "1.0.0" } }),
      "/index.js": 'module.exports = require("some-lib");',
    },
    requested
  ).build("/index.js");
  assert.ok(!requested.some((u) => u.includes("expo-sensors")), `fetched: ${requested.join(", ")}`);
  assert.doesNotMatch(result.bundle, /expo-sensors/);
});

test("a project using expo-sensors gets the wrapped module", async () => {
  const requested = [];
  const result = await bundlerFor(
    {
      "/package.json": JSON.stringify({ name: "t", version: "1.0.0", dependencies: { "expo-sensors": "57.0.3" } }),
      "/index.js": 'module.exports = require("expo-sensors");',
    },
    requested
  ).build("/index.js");
  assert.match(result.bundle, /"expo-sensors__original": function/, "original preserved");
  assert.match(result.bundle, /nativeModule\.addListener = function/, "override emitted");
  assert.ok(!requested.some((u) => u.includes("__original")), "never fetched as a package");
});
