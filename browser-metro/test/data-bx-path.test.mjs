// Regression tests: the data-bx-path plugin scans source text, so it must know where strings and regex
// literals are. Knotsy (Nov 2026) had `.replace(/"/g, "&quot;")`: the `"` inside the regex opened a
// string, every string after it flipped, and `cmd("formatBlock", "<h2>")` got
// ` data-bx-path="..."` written into the string, so the artboard bundle failed with
//   RichEmailEditor.tsx: Unexpected token, expected "," (56:49)
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataBxPathPlugin } from '../dist/plugins/data-bx-path.js';

const run = (src, filename = '/components/E.tsx') => createDataBxPathPlugin().transformSource({ src, filename }).src;

test('a quote inside a regex literal does not open a string (Knotsy)', () => {
  const src = [
    'const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");',
    'const tools = [{ run: () => cmd("formatBlock", "<h2>") }];',
    'export default function E() { return <View />; }',
  ].join('\n');
  const out = run(src);
  assert.match(out, /cmd\("formatBlock", "<h2>"\)/);
  assert.match(out, /replace\(\/"\/g, "&quot;"\)\.replace\(\/<\/g, "&lt;"\)/);
  assert.match(out, /<View dataSet=\{\{"bx-path":"\/components\/E\.tsx:3:38"\}\} \/>/);
});

test('regex literals with classes, escapes and flags are copied whole', () => {
  const src = 'const re = /[/"<a]\\/x/gi;\nconst t = typeof /"/;\nconst el = <div />;';
  const out = run(src);
  assert.ok(out.startsWith('const re = /[/"<a]\\/x/gi;\nconst t = typeof /"/;\n'));
  assert.match(out, /<div data-bx-path="\/components\/E\.tsx:3:12" \/>/);
});

test('division, self-closing tags and closing tags are not regex literals', () => {
  const src = 'const half = total / 2 / count;\nconst a = <Box style={s}/>;\nconst b = <Text>{x}/{y}</Text>;\nconst c = <p>a/b</p>;';
  const out = run(src);
  assert.match(out, /total \/ 2 \/ count/);
  assert.match(out, /<Box dataSet=\{\{"bx-path":"\/components\/E\.tsx:2:11"\}\} style=\{s\}\/>/);
  assert.match(out, /<Text dataSet=\{\{"bx-path":"\/components\/E\.tsx:3:11"\}\}>\{x\}\/\{y\}<\/Text>/);
  assert.match(out, /<p data-bx-path="\/components\/E\.tsx:4:11">a\/b<\/p>/);
});

test('an apostrophe in JSX text does not swallow the tags on later lines', () => {
  const src = 'const a = <Text>Don\'t</Text>;\nconst b = <View />;';
  const out = run(src);
  assert.match(out, /<View dataSet=\{\{"bx-path":"\/components\/E\.tsx:2:11"\}\} \/>/);
});
