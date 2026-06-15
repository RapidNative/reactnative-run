// Regression tests for the HMR runtime's module-loading error semantics.
//
// These drive the REAL emitted runtime (HMR_RUNTIME_TEMPLATE) against a
// controlled module map, so they guard the exact behaviour the preview relies
// on when a module throws during evaluation. The bug they lock in: a module
// that threw on first require used to leave an empty {exports:{}} in the cache
// and return it silently on re-require, masking the root cause behind unrelated
// downstream errors (e.g. "No QueryClient set"). The runtime must instead
// re-throw the ORIGINAL error on every subsequent require (Metro behaviour).
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HMR_RUNTIME_TEMPLATE } from '../dist/hmr-runtime.js';

/**
 * Instantiate the runtime IIFE with a fake `window` and a controlled module
 * map, then hand back the exposed HMR API (which includes `require`).
 *
 * @param {Record<string, (module:any, exports:any, require:Function)=>void>} moduleMap
 * @param {string} entryId  a benign entry that the runtime executes on boot
 */
function makeRuntime(moduleMap, entryId = '__entry__') {
  const win = { addEventListener() {}, __BUNDLER_HMR__: null };
  const modules = { [entryId]: () => {}, ...moduleMap };
  // Template is `(function(modules, reverseDeps, entryId, reactRefreshEnabled){...})`.
  // Wrap it so `window` inside resolves to our fake, then call the IIFE.
  const factory = new Function('window', `return ${HMR_RUNTIME_TEMPLATE};`)(win);
  factory(modules, {}, entryId, false);
  return win.__BUNDLER_HMR__;
}

test('module that throws on eval re-throws the SAME error on re-require (not silent {})', () => {
  const hmr = makeRuntime({
    bad: () => { throw new ReferenceError('boolean is not defined'); },
  });

  let first;
  assert.throws(
    () => hmr.require('bad'),
    (e) => { first = e; return e instanceof ReferenceError && /boolean is not defined/.test(e.message); },
  );

  // The masking bug: this used to return {} instead of throwing.
  let second;
  assert.throws(() => hmr.require('bad'), (e) => { second = e; return true; });
  assert.equal(second, first, 're-require must re-throw the identical original error, not return {}');
});

test('a throwing module does not poison an unrelated sibling module', () => {
  const hmr = makeRuntime({
    bad: () => { throw new Error('boom'); },
    good: (_m, exports) => { exports.ok = 1; },
  });

  assert.throws(() => hmr.require('bad'));
  assert.equal(hmr.require('good').ok, 1, 'sibling module must still load after another throws');
});

test('successful module returns its exports and is cached (same reference on re-require)', () => {
  const hmr = makeRuntime({ good: (_m, exports) => { exports.value = 42; } });

  const a = hmr.require('good');
  assert.equal(a.value, 42);
  assert.equal(hmr.require('good'), a, 're-require returns the same cached exports object');
});

test('requiring an unknown module id throws "Module not found"', () => {
  const hmr = makeRuntime({});
  assert.throws(() => hmr.require('does-not-exist'), /Module not found: does-not-exist/);
});

test('circular dependency returns partial exports mid-eval (no false hasError)', () => {
  // a sets name, then requires b; b sets name, then requires a (still mid-eval)
  // and reads a's already-assigned partial export. Neither must be flagged as errored.
  const hmr = makeRuntime({
    a: (_m, exports, require) => { exports.name = 'a'; exports.b = require('b').name; },
    b: (_m, exports, require) => { exports.name = 'b'; exports.seenFromA = require('a').name; },
  });

  const a = hmr.require('a');
  assert.equal(a.name, 'a');
  assert.equal(a.b, 'b', 'a resolved b through the cycle');

  const b = hmr.require('b');
  assert.equal(b.seenFromA, 'a', 'b saw a\'s partial exports during the cycle');
});
