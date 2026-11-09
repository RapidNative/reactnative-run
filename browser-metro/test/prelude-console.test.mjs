// The native prelude gives the bundle a console before @react-native/js-polyfills/console
// runs. Package chunks open with `var React = require('react')`, so React's development
// build (which reads console.createTask at load) evaluates before that polyfill. React
// Native installs its own console from a scheduler task that can lose the race with the
// bundle, and Expo Go then dies at launch: "Property 'console' doesn't exist" (Nov 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildMetroPrelude } from '../dist/metro-emit.js';

function run(globals) {
  const ctx = vm.createContext({ ...globals });
  // Hermes has no console of its own; neither does a bare vm context once we delete it.
  vm.runInContext('delete globalThis.console;', ctx);
  if (globals.console) ctx.console = globals.console;
  vm.runInContext(buildMetroPrelude({ platform: 'android' }), ctx);
  return ctx;
}

test('without a console, the prelude defines one that React can load against', () => {
  const ctx = run({});
  assert.equal(typeof ctx.console, 'object');
  // what react.development.js does at the top level
  assert.doesNotThrow(() => vm.runInContext('var createTask = console.createTask ? console.createTask : function () { return null; }; createTask();', ctx));
});

test('the prelude console writes through nativeLoggingHook with React Native log levels', () => {
  const lines = [];
  const ctx = run({ nativeLoggingHook: (msg, level) => lines.push([msg, level]) });
  vm.runInContext('console.log("a", 1); console.warn("w"); console.error("e"); console.assert(false, "bad"); console.assert(true, "fine");', ctx);
  assert.deepEqual(lines, [['a 1', 1], ['w', 2], ['e', 3], ['bad', 3]]);
});

test('without nativeLoggingHook the prelude console is silent, not throwing', () => {
  const ctx = run({});
  assert.doesNotThrow(() => vm.runInContext('console.log("x"); console.error(new Error("y")); console.group(); console.groupEnd(); console.time("t"); console.timeEnd("t");', ctx));
});

test('a console that already exists is left alone', () => {
  const mine = { log() {}, marker: true };
  const ctx = run({ console: mine });
  assert.equal(ctx.console, mine);
});
