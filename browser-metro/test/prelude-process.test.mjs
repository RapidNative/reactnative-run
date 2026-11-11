// Packages call Node `process` methods while they load. three 0.187's CommonJS build runs
// process.emitWarning('require("three") is deprecated…') at load, and the prelude's process
// had only `env`, so every app using three / @react-three/* showed a blank preview:
// "process.emitWarning is not a function" (CoachLife, Nov 2026). Both preludes, web and native.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildMetroPrelude } from '../dist/metro-emit.js';
import { buildBundlePreamble } from '../dist/utils.js';

// What three.cjs does as it loads (verbatim shape).
const THREE_CJS = 'process.emitWarning("`require(\\"three\\")` is deprecated", { type: "DeprecationWarning", code: "THREE_CJS_DEPRECATED" });';

for (const [name, prelude] of [
  ['web preamble', () => buildBundlePreamble({}, false, 'web')],
  ['native prelude', () => buildMetroPrelude({ platform: 'ios' })],
]) {
  test(`${name}: a package calling process.emitWarning at load does not throw`, () => {
    const ctx = vm.createContext({});
    vm.runInContext(prelude(), ctx);
    assert.doesNotThrow(() => vm.runInContext(THREE_CJS, ctx));
  });

  test(`${name}: an existing process.emitWarning is kept`, () => {
    const calls = [];
    const ctx = vm.createContext({ process: { env: {}, emitWarning: (m) => calls.push(m) } });
    vm.runInContext(prelude(), ctx);
    vm.runInContext(THREE_CJS, ctx);
    assert.equal(calls.length, 1);
  });
}
