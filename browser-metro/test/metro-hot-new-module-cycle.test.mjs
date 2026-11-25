// "Requiring unknown module" on a phone after an edit that adds a file to a barrel.
//
// A rebuild emits the bundle before the /hot server builds the patch, and emitting the bundle gives
// every module its id. So when buildMetroHmrBody asked the registry whether a module was new, the
// answer was always no: `added` came out empty and the new file went into `modified`. RN's HMRClient
// injects `added` first, then `modified` in order; metro-runtime hot-swaps a redefined module
// synchronously, re-running its factory. With a new file and a barrel importing each other (a cycle,
// so no dependency order exists), the barrel could be swapped before the new file was defined, and
// its factory threw "Requiring unknown module" on the device (2026-11-19/20, two paid projects).
//
// Runs against the REAL metro-runtime prelude; skips without the package server cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitMetroModule, buildMetroHmrBody } from '../dist/metro-emit.js';
import { ModuleIdRegistry } from '../dist/module-ids.js';

const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../reactnative-esm/cache');
const preludeFile = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).find((f) => f.startsWith('prelude-')) : undefined;

const V1 = {
  '/index.tsx': 'globalThis.__SCREEN = require("/app/home.tsx").default;',
  '/app/home.tsx':
    'var ui = require("/components/index.ts"); exports.__esModule = true; exports.default = function Home() { return ui.Button(); };',
  '/components/index.ts': 'exports.Button = require("/components/Button.tsx").Button;',
  '/components/Button.tsx': 'exports.Button = function Button() { return "button"; };',
};

// The edit: a new Card in the barrel, Card uses Button through the barrel, Home shows a Card.
const UPDATE = {
  updatedModules: {
    '/components/index.ts':
      'exports.Button = require("/components/Button.tsx").Button; exports.Card = require("/components/Card.tsx").Card;',
    '/components/Card.tsx':
      'var ui = require("/components/index.ts"); exports.Card = function Card() { return "card+" + ui.Button(); };',
    '/app/home.tsx':
      'var ui = require("/components/index.ts"); exports.__esModule = true; exports.default = function Home() { return ui.Card(); };',
  },
  removedModules: [],
  reverseDepsMap: {
    '/components/index.ts': ['/app/home.tsx', '/components/Card.tsx'],
    '/components/Card.tsx': ['/components/index.ts'],
    '/components/Button.tsx': ['/components/index.ts'],
    '/app/home.tsx': ['/index.tsx'],
    '/index.tsx': [],
  },
};

function bundleV1(registry) {
  return Object.entries(V1).map(([k, code]) => emitMetroModule(code, k, registry).text);
}

test('a new file is sent as added even though the rebuild already gave it an id', () => {
  const registry = new ModuleIdRegistry();
  bundleV1(registry);
  // What emitBundle() does during the rebuild, before the patch is built.
  for (const k of Object.keys(UPDATE.updatedModules)) registry.idFor(k);
  const body = buildMetroHmrBody({ ...UPDATE, addedModules: Object.keys(UPDATE.updatedModules).filter((k) => !(k in V1)) }, registry, 'rev-1');
  assert.deepEqual(body.added.map((e) => e.sourceURL), ['/components/Card.tsx']);
  assert.deepEqual(body.modified.map((e) => e.sourceURL).sort(), ['/app/home.tsx', '/components/index.ts']);
});

test('the patch applies on the real metro-runtime: no "Requiring unknown module"', async (t) => {
  if (!preludeFile) {
    t.skip('no cached prelude (start reactnative-esm and fetch /prelude/<rnVersion> once)');
    return;
  }
  const prelude = fs.readFileSync(path.join(cacheDir, preludeFile), 'utf8');
  const registry = new ModuleIdRegistry();
  const v1 = bundleV1(registry);
  for (const k of Object.keys(UPDATE.updatedModules)) registry.idFor(k);
  const body = buildMetroHmrBody({ ...UPDATE, addedModules: Object.keys(UPDATE.updatedModules).filter((k) => !(k in V1)) }, registry, 'rev-1');
  // RN's HMRClient: added first, then modified, each evaluated in order.
  const inject = [...body.added, ...body.modified].map((e) => e.module[1]).join('\n');
  const script = `
    var global = globalThis; global.global = global;
    var __DEV__ = true; var __METRO_GLOBAL_PREFIX__ = '';
    global.__ReactRefresh = {
      isLikelyComponentType: (f) => typeof f === 'function' && /^[A-Z]/.test(f.name || ''),
      register() {}, performReactRefresh() {}, getFamilyByType() { return undefined; },
    };
    ${prelude}
    ${v1.join('\n')}
    __r(${registry.idFor('/index.tsx')});
    var before = globalThis.__SCREEN();
    ${inject}
    return { before, after: __r(${registry.idFor('/app/home.tsx')}).default() };
  `;
  const result = new Function(script)();
  assert.equal(result.before, 'button');
  assert.equal(result.after, 'card+button');
  delete globalThis.__SCREEN;
  delete globalThis.__ReactRefresh;
});

test('the bundler records which modules a rebuild added (it has given them ids by then)', async () => {
  const { IncrementalBundler } = await import('../dist/incremental-bundler.js');
  const { VirtualFS } = await import('../dist/fs.js');
  const { typescriptTransformer } = await import('../dist/transforms/typescript.js');
  const vfs = new VirtualFS({});
  vfs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  vfs.write('/index.ts', `import { Home } from './app/home';\nHome();\n`);
  vfs.write('/app/home.ts', `import { Button } from '../components';\nexport const Home = () => Button();\n`);
  vfs.write('/components/index.ts', `export { Button } from './Button';\n`);
  vfs.write('/components/Button.ts', `export const Button = () => 'button';\n`);
  const bundler = new IncrementalBundler(vfs, {
    resolver: { sourceExts: ['ts', 'tsx', 'js'] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: 'http://127.0.0.1:0' },
    output: { format: 'metro', prelude: '/* prelude */' },
    hmr: { enabled: true },
  });
  await bundler.build('/index.ts');

  vfs.write('/components/index.ts', `export { Button } from './Button';\nexport { Card } from './Card';\n`);
  vfs.write('/components/Card.ts', `import { Button } from './index';\nexport const Card = () => 'card+' + Button();\n`);
  vfs.write('/app/home.ts', `import { Card } from '../components';\nexport const Home = () => Card();\n`);
  const result = await bundler.rebuild([
    { type: 'update', path: '/components/index.ts' },
    { type: 'create', path: '/components/Card.ts' },
    { type: 'update', path: '/app/home.ts' },
  ]);
  assert.ok(result.hmrUpdate && !result.hmrUpdate.requiresReload);
  // The bug's precondition: the new file already has an id when the patch is built.
  assert.equal(bundler.moduleIds.has('/components/Card.ts'), true);
  assert.deepEqual(result.hmrUpdate.addedModules, ['/components/Card.ts']);
  const body = buildMetroHmrBody(result.hmrUpdate, bundler.moduleIds, 'rev-2');
  assert.deepEqual(body.added.map((e) => e.sourceURL), ['/components/Card.ts']);
  assert.ok(!body.modified.some((e) => e.sourceURL === '/components/Card.ts'));
});
