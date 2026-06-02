import type { BundlerPlugin } from "../types.js";

/**
 * Shim for `expo-modules-core` that runs in the browser.
 *
 * `expo-modules-core` is the foundation that every Expo native module is built
 * on. Its main exports (EventEmitter, NativeModule, requireNativeModule,
 * permission hooks, …) are needed by virtually every community Expo package
 * that ships a web fallback. The package itself does have a web build, but
 * fetching it from the package server is unnecessary — a small inline shim
 * gives us correct semantics for everything that matters in preview.
 *
 * Native-module lookup goes through `globalThis.__EXPO_WEB_MODULES__`. Other
 * shims (e.g. `expo-speech-recognition`) can register their web impl there if
 * they want `requireNativeModule()` to resolve to it — but most package shims
 * just replace the public surface directly and never go through that path.
 */
export const EXPO_MODULES_CORE_SHIM = `
"use strict";

// ----- EventEmitter -----------------------------------------------------
// Real expo-modules-core: \`new EventEmitter(nativeModule)\` proxies listeners
// to the native module's own emitter so events emitted from the module flow
// out via the wrapping emitter. We honor that contract so community packages
// like expo-speech-recognition (which does \`new EventEmitter(Module)\`) work.

function _ownEmitter() { return { _listeners: Object.create(null) }; }

function _emitOn(target, eventName, args) {
  var set = target._listeners[eventName];
  if (!set || set.size === 0) return;
  set.forEach(function (fn) {
    try { fn.apply(null, args); } catch (e) { setTimeout(function () { throw e; }, 0); }
  });
}

function _EventEmitter(nativeModule) {
  // If a native-module-like object is passed, hijack its emitter (or attach one)
  // so emit()/addListener() share state with the module.
  this._target = (nativeModule && typeof nativeModule === "object") ? nativeModule : null;
  if (this._target) {
    if (!this._target.__emitter) this._target.__emitter = _ownEmitter();
  } else {
    this.__emitter = _ownEmitter();
  }
}
_EventEmitter.prototype._get = function () {
  return this._target ? this._target.__emitter : this.__emitter;
};
_EventEmitter.prototype.addListener = function (eventName, listener) {
  if (typeof listener !== "function") return { remove: function () {} };
  var emt = this._get();
  var set = emt._listeners[eventName] || (emt._listeners[eventName] = new Set());
  set.add(listener);
  return {
    remove: function () {
      if (emt._listeners[eventName]) emt._listeners[eventName].delete(listener);
    },
  };
};
_EventEmitter.prototype.removeListener = function (eventName, listener) {
  var emt = this._get();
  if (emt._listeners[eventName]) emt._listeners[eventName].delete(listener);
};
_EventEmitter.prototype.removeAllListeners = function (eventName) {
  var emt = this._get();
  if (eventName === undefined) emt._listeners = Object.create(null);
  else delete emt._listeners[eventName];
};
_EventEmitter.prototype.emit = function (eventName) {
  _emitOn(this._get(), eventName, Array.prototype.slice.call(arguments, 1));
};
_EventEmitter.prototype.listenerCount = function (eventName) {
  var emt = this._get();
  return emt._listeners[eventName] ? emt._listeners[eventName].size : 0;
};

// ----- NativeModule base class -----------------------------------------
// Expo modules that ship a web impl typically do:
//   class FooWebModule extends NativeModule { ... }
//   const Foo = registerWebModule(FooWebModule, "Foo");
// The instance must itself be event-emittable so \`Module.emit('x', ...)\`
// fans out to listeners installed via \`new EventEmitter(Module)\`.

function _NativeModule() {
  this.__emitter = _ownEmitter();
}
_NativeModule.prototype.addListener = function (eventName, listener) {
  if (typeof listener !== "function") return { remove: function () {} };
  var set = this.__emitter._listeners[eventName] || (this.__emitter._listeners[eventName] = new Set());
  set.add(listener);
  var self = this;
  return { remove: function () { self.__emitter._listeners[eventName] && self.__emitter._listeners[eventName].delete(listener); } };
};
_NativeModule.prototype.removeListener = function (eventName, listener) {
  if (this.__emitter._listeners[eventName]) this.__emitter._listeners[eventName].delete(listener);
};
_NativeModule.prototype.removeAllListeners = function (eventName) {
  if (eventName === undefined) this.__emitter._listeners = Object.create(null);
  else delete this.__emitter._listeners[eventName];
};
_NativeModule.prototype.emit = function (eventName) {
  _emitOn(this.__emitter, eventName, Array.prototype.slice.call(arguments, 1));
};
_NativeModule.prototype.listenerCount = function (eventName) {
  return this.__emitter._listeners[eventName] ? this.__emitter._listeners[eventName].size : 0;
};
_NativeModule.prototype.startObserving = function () {};
_NativeModule.prototype.stopObserving = function () {};

function _SharedObject() { _NativeModule.call(this); }
_SharedObject.prototype = Object.create(_NativeModule.prototype);
_SharedObject.prototype.constructor = _SharedObject;
_SharedObject.prototype.release = function () {};

function _SharedRef() { _NativeModule.call(this); }
_SharedRef.prototype = Object.create(_NativeModule.prototype);
_SharedRef.prototype.constructor = _SharedRef;

// ----- Errors / enums --------------------------------------------------

function _UnavailabilityError(moduleName, propertyName) {
  var msg = "The method or property " + moduleName + "." + propertyName + " is not available on web";
  var err = new Error(msg);
  err.code = "ERR_UNAVAILABLE";
  return err;
}
_UnavailabilityError.prototype = Object.create(Error.prototype);

var PermissionStatus = {
  UNDETERMINED: "undetermined",
  GRANTED: "granted",
  DENIED: "denied",
};

// ----- Native module registry / lookup ---------------------------------

function _registry() {
  var g = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : {});
  if (!g.__ExpoModulesCore_NativeModules__) g.__ExpoModulesCore_NativeModules__ = {};
  if (!g.__EXPO_WEB_MODULES__) g.__EXPO_WEB_MODULES__ = g.__ExpoModulesCore_NativeModules__;
  return g.__ExpoModulesCore_NativeModules__;
}

function requireNativeModule(moduleName) {
  var reg = _registry();
  if (reg[moduleName]) return reg[moduleName];
  throw new Error(
    "Cannot find native module '" + moduleName + "' — no web implementation registered in browser preview."
  );
}

function requireOptionalNativeModule(moduleName) {
  var reg = _registry();
  return reg[moduleName] || null;
}

/**
 * registerWebModule(impl, moduleName) — the modern entry point used by
 * community Expo packages' web builds. \`impl\` can be a class (we'll \`new\`
 * it) or an already-constructed instance. The instance is registered on
 * the global registry so later \`requireNativeModule(name)\` calls find it.
 */
function registerWebModule(impl, moduleName) {
  var instance;
  if (typeof impl === "function") {
    try { instance = new impl(); } catch (e) {
      // If the class can't be \`new\`'d (e.g. uses class-fields with broken
      // transpile), fall back to the function itself as a last resort.
      instance = impl;
    }
  } else {
    instance = impl || {};
  }
  var reg = _registry();
  if (moduleName) reg[moduleName] = instance;
  return instance;
}

function createPermissionHook(descriptor) {
  var React = require("react");
  return function usePermissions(options) {
    var state = React.useState(null);
    var permission = state[0];
    var setPermission = state[1];
    var request = React.useCallback(function () {
      return Promise.resolve(
        descriptor && descriptor.requestMethod
          ? descriptor.requestMethod()
          : { status: "undetermined", granted: false, canAskAgain: true, expires: "never" }
      ).then(function (next) { setPermission(next); return next; });
    }, []);
    var get = React.useCallback(function () {
      return Promise.resolve(
        descriptor && descriptor.getMethod
          ? descriptor.getMethod()
          : { status: "undetermined", granted: false, canAskAgain: true, expires: "never" }
      ).then(function (next) { setPermission(next); return next; });
    }, []);
    React.useEffect(function () {
      if (options && options.get) get();
      else if (options && options.request) request();
    }, []);
    return [permission, request, get];
  };
}

var NativeModulesProxy = typeof Proxy !== "undefined"
  ? new Proxy({}, { get: function (_, k) { return k === "__esModule" ? true : undefined; } })
  : {};

// uuid helper used by a few Expo modules
function _uuidv4() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Platform is re-exported by expo-modules-core in modern versions. expo-router's
// getInitialURL/useStore reads Platform.OS off it; missing => undefined.OS crash.
var Platform = {
  OS: "web",
  Version: undefined,
  isPad: false,
  isTV: false,
  isTesting: false,
  select: function (specifics) {
    if (specifics == null) return undefined;
    if ("web" in specifics) return specifics.web;
    if ("default" in specifics) return specifics["default"];
    return undefined;
  },
};

// CodedError is the canonical error type used by many Expo modules.
function _CodedError(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}
_CodedError.prototype = Object.create(Error.prototype);

exports.EventEmitter = _EventEmitter;
exports.LegacyEventEmitter = _EventEmitter;
exports.NativeModule = _NativeModule;
exports.SharedObject = _SharedObject;
exports.SharedRef = _SharedRef;
exports.UnavailabilityError = _UnavailabilityError;
exports.CodedError = _CodedError;
exports.PermissionStatus = PermissionStatus;
exports.NativeModulesProxy = NativeModulesProxy;
exports.Platform = Platform;
exports.requireNativeModule = requireNativeModule;
exports.requireOptionalNativeModule = requireOptionalNativeModule;
exports.registerWebModule = registerWebModule;
exports.createPermissionHook = createPermissionHook;
exports.uuid = { v4: _uuidv4 };
exports.default = exports;
exports.__esModule = true;
`;

/**
 * Shim for `expo-speech-recognition` (jamsch) that wraps the browser's
 * Web Speech API (`window.SpeechRecognition` / `webkitSpeechRecognition`).
 *
 * Mirrors the package's public surface — `ExpoSpeechRecognitionModule`,
 * `ExpoSpeechRecognitionModuleEmitter`, `useSpeechRecognitionEvent` — so
 * consumer code that did `import { ExpoSpeechRecognitionModule } from
 * 'expo-speech-recognition'` keeps working unchanged. Event payloads match
 * the native module's shape so listener code doesn't need branching.
 *
 * Limitations vs native: no on-device-only mode, no contextual strings, no
 * Android intents/iOS task hints — the browser API has no equivalents.
 */
export const EXPO_SPEECH_RECOGNITION_SHIM = `
"use strict";

var _core = require("expo-modules-core");
var React = require("react");

function _getCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

var _supported = !!_getCtor();
var _emitter = new _core.EventEmitter();
var _current = null;
var _state = "inactive";

function _teardown(method) {
  if (!_current) return;
  _state = "stopping";
  try { _current[method](); } catch (e) {}
}

function _emitResult(ev) {
  var results = [];
  var isFinal = false;
  for (var i = ev.resultIndex; i < ev.results.length; i++) {
    var r = ev.results[i];
    if (r.isFinal) isFinal = true;
    var segments = [];
    for (var j = 0; j < r.length; j++) {
      segments.push({ transcript: r[j].transcript, confidence: r[j].confidence });
    }
    results.push({
      isFinal: r.isFinal,
      transcript: r[0].transcript,
      confidence: r[0].confidence,
      segments: segments,
    });
  }
  _emitter.emit(isFinal ? "result" : "partialresult", { results: results, isFinal: isFinal });
}

var ExpoSpeechRecognitionModule = {
  start: function (options) {
    if (!_supported) {
      _emitter.emit("error", { error: "not-supported", message: "SpeechRecognition is not supported in this browser." });
      _emitter.emit("end");
      return;
    }
    if (_current) _teardown("abort");
    var Ctor = _getCtor();
    var rec = new Ctor();
    options = options || {};
    rec.lang = options.lang || (typeof navigator !== "undefined" && navigator.language) || "en-US";
    rec.continuous = options.continuous !== false;
    rec.interimResults = !!options.interimResults;
    rec.maxAlternatives = options.maxAlternatives || 1;

    rec.onstart = function () { _state = "recognizing"; _emitter.emit("start"); };
    rec.onend = function () { _state = "inactive"; _current = null; _emitter.emit("end"); };
    rec.onerror = function (ev) {
      _emitter.emit("error", { error: ev.error || "unknown", message: ev.message || ev.error || "Speech recognition error" });
    };
    rec.onaudiostart = function () { _emitter.emit("audiostart", { uri: null }); };
    rec.onaudioend = function () { _emitter.emit("audioend", { uri: null }); };
    rec.onsoundstart = function () { _emitter.emit("soundstart"); };
    rec.onsoundend = function () { _emitter.emit("soundend"); };
    rec.onspeechstart = function () { _emitter.emit("speechstart"); };
    rec.onspeechend = function () { _emitter.emit("speechend"); };
    rec.onnomatch = function () { _emitter.emit("nomatch"); };
    rec.onresult = _emitResult;

    _current = rec;
    _state = "starting";
    try { rec.start(); } catch (e) {
      _state = "inactive";
      _current = null;
      _emitter.emit("error", { error: "start-failed", message: e && e.message ? e.message : String(e) });
      _emitter.emit("end");
    }
  },
  stop: function () { _teardown("stop"); },
  abort: function () { _teardown("abort"); },
  requestPermissionsAsync: function () {
    if (typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
      }, function () {
        return { status: "denied", granted: false, canAskAgain: false, expires: "never" };
      });
    }
    return Promise.resolve({ status: "undetermined", granted: false, canAskAgain: true, expires: "never" });
  },
  getPermissionsAsync: function () {
    if (typeof navigator !== "undefined" && navigator.permissions && navigator.permissions.query) {
      return navigator.permissions.query({ name: "microphone" }).then(
        function (r) {
          var status = r.state === "granted" ? "granted" : r.state === "denied" ? "denied" : "undetermined";
          return { status: status, granted: status === "granted", canAskAgain: status !== "denied", expires: "never" };
        },
        function () {
          return { status: "undetermined", granted: false, canAskAgain: true, expires: "never" };
        }
      );
    }
    return Promise.resolve({ status: "undetermined", granted: false, canAskAgain: true, expires: "never" });
  },
  getStateAsync: function () { return Promise.resolve(_state); },
  getSpeechRecognitionServices: function () { return _supported ? ["web"] : []; },
  getSupportedLocales: function () {
    var locale = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    return Promise.resolve({ locales: [locale], installedLocales: [locale] });
  },
  isOnDeviceRecognitionAvailable: function () { return false; },
  androidTriggerOfflineModelDownload: function () { return Promise.resolve({ status: "unsupported" }); },
  setCategoryIOS: function () {},
  setAudioSessionActiveIOS: function () {},
};

function useSpeechRecognitionEvent(eventName, listener) {
  React.useEffect(function () {
    var sub = _emitter.addListener(eventName, listener);
    return function () { sub.remove(); };
  }, [eventName, listener]);
}

// Register on the global registry so requireNativeModule("ExpoSpeechRecognition")
// also resolves to this implementation (in case a consumer reaches in directly).
(function () {
  var g = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : null);
  if (g) {
    g.__EXPO_WEB_MODULES__ = g.__EXPO_WEB_MODULES__ || {};
    g.__EXPO_WEB_MODULES__.ExpoSpeechRecognition = ExpoSpeechRecognitionModule;
  }
})();

exports.ExpoSpeechRecognitionModule = ExpoSpeechRecognitionModule;
exports.ExpoSpeechRecognitionModuleEmitter = _emitter;
exports.useSpeechRecognitionEvent = useSpeechRecognitionEvent;
exports.default = ExpoSpeechRecognitionModule;
exports.__esModule = true;
`;

/**
 * Plugin factory that registers Expo-related web shims with the bundler.
 *
 * Usage:
 *   const config: BundlerConfig = {
 *     ...,
 *     plugins: [createExpoWebShimsPlugin(), ...otherPlugins],
 *   };
 *
 * Consumer plugins listed after this one can override individual shims by
 * returning the same key from their own `shimModules()` — `Object.assign`
 * later-wins semantics apply (see IncrementalBundler.getShimModules).
 */
export function createExpoWebShimsPlugin(): BundlerPlugin {
  return {
    name: "expo-web-shims",
    shimModules() {
      return {
        "expo-modules-core": EXPO_MODULES_CORE_SHIM,
        "expo-speech-recognition": EXPO_SPEECH_RECOGNITION_SHIM,
      };
    },
  };
}
