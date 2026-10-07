// Regression tests: an imported .json file is a module whose value is the
// parsed document (Metro parity), not JavaScript source.
//
// The bug they lock in: .json went through the JS transformer, which parses
// `{ "scale": 0.82 }` as a block statement and failed every bundle with
//   /text-scale.json: Unexpected token (2:9)
// Lifo's artboard bundler wraps .json in its expo-web plugin, so the same
// project rendered on artboards but 500'd on the rnrun dev server.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { Bundler } from '../dist/bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';

const CONFIG = {
  resolver: { sourceExts: ['js', 'ts', 'tsx', 'jsx', 'json'] },
  transformer: typescriptTransformer,
  // Never reached — these projects have no npm deps to fetch.
  server: { packageServerUrl: 'http://127.0.0.1:0' },
};

function makeFs() {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  fs.write('/text-scale.json', `{\n  "scale": 0.82\n}\n`);
  fs.write('/app/index.tsx',
    `import textScale from '../text-scale.json';\nexport const SCALE = textScale.scale * 100;\n`);
  return fs;
}

test('incremental: an imported .json builds as a module', async () => {
  const bundler = new IncrementalBundler(makeFs(), CONFIG);
  const result = await bundler.build('/app/index.tsx');
  assert.ok(result.bundle.includes('module.exports = {"scale":0.82};'));
});

test('incremental: editing an imported .json rebuilds with the new value', async () => {
  const fs = makeFs();
  const bundler = new IncrementalBundler(fs, CONFIG);
  await bundler.build('/app/index.tsx');

  fs.write('/text-scale.json', `{ "scale": 0.9 }\n`);
  const result = await bundler.rebuild([{ type: 'update', path: '/text-scale.json' }]);
  assert.ok(result.bundle.includes('module.exports = {"scale":0.9};'));
});

test('incremental: malformed .json reports a JSON error naming the file', async () => {
  const fs = makeFs();
  fs.write('/text-scale.json', `{ "scale": 0.82, }\n`);
  const bundler = new IncrementalBundler(fs, CONFIG);
  await assert.rejects(bundler.build('/app/index.tsx'), /\/text-scale\.json: Invalid JSON/);
});

test('bundler: an imported .json builds as a module', async () => {
  const bundle = await new Bundler(makeFs(), CONFIG).bundle('/app/index.tsx');
  assert.ok(bundle.includes('module.exports = {"scale":0.82};'));
});
