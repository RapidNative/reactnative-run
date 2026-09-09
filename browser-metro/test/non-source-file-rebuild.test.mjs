// Regression tests: non-source files that nothing imports must never enter
// the bundle graph through rebuild().
//
// The bug they lock in: rebuild() reprocessed EVERY changed non-config file,
// so saving eas.json, or npm rewriting package-lock.json, ran the file
// through the JS transformer and failed the whole rebuild with
//   /eas.json: Unexpected token (2:7)
// even though no module imports it (Metro only walks from the entry, so the
// same edit is a no-op there). rnrun surfaced this as a "Build error" for an
// edit that never touched the app.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';

const CONFIG = {
  resolver: { sourceExts: ['js', 'ts', 'tsx', 'jsx'] },
  transformer: typescriptTransformer,
  // Never reached — these projects have no npm deps to fetch.
  server: { packageServerUrl: 'http://127.0.0.1:0' },
};

function makeBundler() {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  fs.write('/app/index.tsx', `export default function Home() { return null; }\n`);
  return { fs, bundler: new IncrementalBundler(fs, CONFIG) };
}

test('saving eas.json does not fail the rebuild', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  fs.write('/eas.json', `{\n  "cli": { "version": ">= 15.0.0" },\n  "build": {}\n}\n`);
  const result = await bundler.rebuild([{ type: 'create', path: '/eas.json' }]);
  assert.ok(result, 'rebuild completed');
});

test('a rewritten package-lock.json and a README are ignored alongside a real change', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  fs.write('/app/index.tsx', `export default function Home() { return 'v2'; }\n`);
  fs.write('/package-lock.json', `{\n  "name": "app",\n  "lockfileVersion": 3\n}\n`);
  fs.write('/README.md', `# App\n\nNot JavaScript.\n`);
  const result = await bundler.rebuild([
    { type: 'update', path: '/app/index.tsx' },
    { type: 'update', path: '/package-lock.json' },
    { type: 'create', path: '/README.md' },
  ]);
  assert.ok(result, 'rebuild completed');
  assert.ok(result.bundle.includes('v2'), 'the real change still landed');
});

test('a new source file is still processed', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  // A genuine module (e.g. a new screen) must keep going through the
  // transformer -- the exclusion is only for files the transformer cannot take.
  fs.write('/app/about.tsx', `export default function About() { return 'about'; }\n`);
  const result = await bundler.rebuild([{ type: 'create', path: '/app/about.tsx' }]);
  assert.ok(result, 'rebuild completed');
});
