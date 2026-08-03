// Regression tests: build-tooling config files must never enter the bundle
// graph through rebuild().
//
// The bug they lock in: the initial build() walks from the entry, so
// eslint.config.js / babel.config.js etc. naturally stay out of the graph.
// But rebuild() reprocessed EVERY changed file — so when an AI generation or
// zip import WROTE eslint.config.js into the VFS, the rebuild transformed it,
// found its Node-side import (`eslint/config`), and assertDeclaredNpmDeps
// killed the whole rebuild with:
//   Unable to resolve "eslint/config" from "eslint.config.js"
//     "eslint" is not listed in package.json "dependencies". ...
// even though nothing in the app imports that file. A crashed rebuild also
// leaves the module map inconsistent, cascading into unrelated errors.
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

/** Minimal dependency-free project so build() succeeds without a package server. */
function makeBundler() {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  fs.write('/app/index.tsx', `export default function Home() { return null; }\n`);
  return { fs, bundler: new IncrementalBundler(fs, CONFIG) };
}

test('writing eslint.config.js does not fail the rebuild', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  fs.write(
    '/eslint.config.js',
    `import { defineConfig } from 'eslint/config';\nexport default defineConfig([]);\n`,
  );
  // Must not throw "Unable to resolve eslint/config" — the config file is
  // Node-side tooling, not part of the bundle.
  const result = await bundler.rebuild([{ type: 'create', path: '/eslint.config.js' }]);
  assert.ok(result, 'rebuild completed');
});

test('config files are excluded even alongside real changes', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  fs.write('/app/index.tsx', `export default function Home() { return 'v2'; }\n`);
  fs.write(
    '/babel.config.js',
    `module.exports = { presets: [require('babel-preset-expo')] };\n`,
  );
  const result = await bundler.rebuild([
    { type: 'update', path: '/app/index.tsx' },
    { type: 'create', path: '/babel.config.js' },
  ]);
  assert.ok(result, 'rebuild completed');
});

test('a real app file with an undeclared import still fails fast', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  // The exclusion must be surgical: genuine app files keep Metro-parity
  // fail-fast on undeclared dependencies.
  fs.write(
    '/app/index.tsx',
    `import { thing } from 'not-declared-pkg';\nexport default function Home() { return thing; }\n`,
  );
  await assert.rejects(
    () => bundler.rebuild([{ type: 'update', path: '/app/index.tsx' }]),
    /Unable to resolve "not-declared-pkg"/,
  );
});
