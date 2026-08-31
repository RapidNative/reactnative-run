// Regression tests for stubMissingModule.
//
// The bug they lock in: a require() of a file absent from the VFS — most
// often a binary asset that never reached the workspace — was silently
// skipped by the dependency walk, while the importer's dependency map still
// referenced it. On metro-format output that minted a numeric id the bundle
// never defined, and Expo Go booted fine only to throw the unactionable
// 'Requiring unknown module "N"' on every render of the importing component.
// The bundler must instead DEFINE the id with a factory that throws a
// Metro-style "Unable to resolve" naming the missing file, and must replace
// the stub with the real module on the rebuild that creates the file.
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
  // Never reached — these projects declare no npm dependencies.
  server: { packageServerUrl: 'http://127.0.0.1:0' },
  output: { format: 'metro', prelude: '/* prelude */' },
  hmr: { enabled: true },
};

function makeFs(files) {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  for (const [path, content] of Object.entries(files)) fs.write(path, content);
  return fs;
}

/** Every numeric id a dependency map references must be defined by a __d(). */
function assertNoDanglingIds(bundle) {
  const defined = new Set();
  const depmaps = [];
  for (const m of bundle.matchAll(/\},\s*(\d+),\s*\[([0-9,\s]*)\](?:,\s*"[^"]*")?\);/g)) {
    defined.add(Number(m[1]));
    depmaps.push(m[2]);
  }
  assert.ok(defined.size > 0, 'expected at least one __d module in the bundle');
  for (const deps of depmaps) {
    for (const d of deps.split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(
        defined.has(Number(d)),
        `dependency map references module id ${d}, which the bundle never defines`,
      );
    }
  }
}

test('a required-but-missing asset gets a defined, throwing stub (no dangling id)', async () => {
  const fs = makeFs({
    '/index.js': 'module.exports = require("./assets/logo.png");',
  });
  const bundler = new IncrementalBundler(fs, CONFIG);
  const result = await bundler.build('/index.js');

  assertNoDanglingIds(result.bundle);
  assert.match(result.bundle, /Unable to resolve \\?"\/assets\/logo\.png\\?" from \\?"\/index\.js\\?"/);
  assert.match(result.bundle, /asset file is missing/);
});

test('a missing source sibling (mid-stream barrel) gets a stub instead of a dangling ref', async () => {
  const fs = makeFs({
    '/index.js': 'module.exports = require("./not-written-yet.js");',
  });
  const bundler = new IncrementalBundler(fs, CONFIG);
  const result = await bundler.build('/index.js');

  assertNoDanglingIds(result.bundle);
  assert.match(result.bundle, /Unable to resolve \\?".*not-written-yet/);
});

// The stub text as it appears in emitted output, where JSON.stringify has
// escaped the inner quotes (\"/assets/logo.png\").
const STUB_RE = /Unable to resolve \\?"\/assets\/logo\.png\\?"/;

test('an edit that adds a missing require ships the stub in the HMR payload', async () => {
  // The edited file must NOT be the entry: an entry edit forces a full
  // reload (empty HMR payload), and the reloaded bundle carries the stub
  // via the initial-build path already covered above.
  const fs = makeFs({
    '/index.js': 'module.exports = require("./screen.js");',
    '/screen.js': 'module.exports = 1;',
  });
  const bundler = new IncrementalBundler(fs, CONFIG);
  await bundler.build('/index.js');

  fs.write('/screen.js', 'module.exports = require("./assets/logo.png");');
  const result = await bundler.rebuild([{ path: '/screen.js', type: 'update' }]);

  assert.ok(result.hmrUpdate, 'expected an HMR update');
  assert.equal(result.hmrUpdate.requiresReload, false);
  const stub = result.hmrUpdate.updatedModules['/assets/logo.png'];
  assert.ok(stub, 'expected the missing asset to appear in updatedModules');
  assert.match(stub, /Unable to resolve \\?"\/assets\/logo\.png\\?" from \\?"\/screen\.js\\?"/);
  assertNoDanglingIds(result.bundle);
});

test('the stub is replaced by the real module on the rebuild that creates the file', async () => {
  const fs = makeFs({
    '/index.js': 'module.exports = require("./assets/logo.png");',
  });
  const bundler = new IncrementalBundler(fs, CONFIG);
  const first = await bundler.build('/index.js');
  assert.match(first.bundle, STUB_RE);

  fs.write('/assets/logo.png', 'binary-bytes');
  const result = await bundler.rebuild([{ path: '/assets/logo.png', type: 'create' }]);

  const mod = result.hmrUpdate?.updatedModules['/assets/logo.png'];
  assert.ok(mod, 'expected the created asset to appear in updatedModules');
  assert.ok(!/Unable to resolve/.test(mod), 'the stub must be replaced by the real asset module');
  assert.ok(!STUB_RE.test(result.bundle), 'the full bundle must no longer carry the stub');
});
