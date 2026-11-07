// Regression tests: `export const A = 1, B = 2` exports both names.
//
// sucrase 3.35.1 compiles it to `const A = 1; exports.A = A, B = 2;`: B was never exported,
// so `import { B }` was undefined on rnrun while local Metro (Babel) was fine. ValueX's
// charts kit crashed on hosted previews with "Cannot read property 'displayName' of undefined".
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typescriptTransformer } from '../dist/transforms/typescript.js';
import { splitMultiDeclaratorExports } from '../dist/transforms/split-exports.js';

const run = (src, filename = '/m.tsx') => {
  const { code } = typescriptTransformer.transform({ src, filename });
  const exports = {};
  const React = { createElement: (t) => t };
  new Function('exports', 'require', 'React', 'o', 'arr', code)(exports, () => ({}), React, { a: 1, b: 2 }, [3]);
  return exports;
};

test('every declarator of an exported const/let/var is exported', () => {
  assert.deepEqual(run('export const A = 1, B = 2;'), { A: 1, B: 2 });
  assert.deepEqual(run('export let A = 1,\n  B = 2', '/m.js'), { A: 1, B: 2 });
  assert.deepEqual(run('export var A = 1, B = 3;', '/m.ts'), { A: 1, B: 3 });
  const typed = run('export const A: number = 1, /* note, here */ B: Record<string, number> = { x: 2 };', '/m.ts');
  assert.deepEqual(typed, { A: 1, B: { x: 2 } });
  const d = run('export const { a, b } = o, [c] = arr;', '/m.ts');
  assert.deepEqual({ a: d.a, b: d.b, c: d.c }, { a: 1, b: 2, c: 3 });
  const jsx = run('export const Bar = () => <div />,\n  LabelList = () => null,\n  Cell = () => null;');
  assert.equal(typeof jsx.Bar, 'function');
  assert.equal(typeof jsx.LabelList, 'function');
  assert.equal(typeof jsx.Cell, 'function');
});

test('the rewrite keeps line numbers and leaves other code alone', () => {
  const src = 'export const A = 1,\n  B = 2;\nexport const C = f(1, 2), D = [3, 4];\n';
  const out = splitMultiDeclaratorExports(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.equal(out, 'export const A = 1; export const\n  B = 2;\nexport const C = f(1, 2); export const D = [3, 4];\n');
  for (const same of [
    'export const A = f(1, 2);',
    'export const A = { a: 1, b: 2 };',
    'const A = 1, B = 2;\nexport { A, B };',
    'export declare const A: number, B: string;',
    'export const A = 1,', // a syntax error: left for sucrase to report
  ]) assert.equal(splitMultiDeclaratorExports(same), same);
});
