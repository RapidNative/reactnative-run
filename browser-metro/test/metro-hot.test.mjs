// Native Fast Refresh mechanics, verified OFFLINE against the real
// metro-runtime prelude (the same file the device runs, cached by the
// package server). This is the harness that found the load-bearing contract:
// metro-runtime's define() treats a __d redefinition WITHOUT the 5th
// argument (inverseDependencies) as a silent no-op.
//
// Requires a cached prelude (reactnative-esm/cache/prelude-*.js); skips
// gracefully when absent so CI without the server cache stays green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitMetroModule, buildMetroHmrBody } from '../dist/metro-emit.js';
import { ModuleIdRegistry } from '../dist/module-ids.js';

const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../reactnative-esm/cache');
const preludeFile = fs.existsSync(cacheDir)
  ? fs.readdirSync(cacheDir).find((f) => f.startsWith('prelude-'))
  : undefined;

test('emitMetroModule: dependencyMap rewrite, ids, verboseName, inverseDependencies', () => {
  const registry = new ModuleIdRegistry();
  const { text, depKeys } = emitMetroModule(
    'var a = require("/lib/a.ts"); var b = require("react"); var a2 = require("/lib/a.ts");',
    '/index.ts',
    registry,
    { inverseDependencies: { 0: [] } }
  );
  assert.deepEqual(depKeys, ['/lib/a.ts', 'react']);
  // Both occurrences of the same dep map to the same index.
  assert.equal((text.match(/_dependencyMap\[0\]/g) || []).length, 2);
  assert.match(text, /_dependencyMap\[1\]/);
  assert.match(text, /, 0, \[1,2\], "\/index\.ts", \{"0":\[\]\}\);$/);
});

test('buildMetroHmrBody: modified vs added, deleted ids, ancestor closure', () => {
  const registry = new ModuleIdRegistry();
  registry.idFor('/index.ts'); // 0 — known
  registry.idFor('/a.ts'); // 1 — known
  const body = buildMetroHmrBody(
    {
      updatedModules: { '/a.ts': 'exports.x = 1;', '/new.ts': 'exports.y = 2;' },
      removedModules: ['/gone.ts', '/index.ts'],
      reverseDepsMap: { '/a.ts': ['/index.ts'], '/index.ts': [] },
    },
    registry,
    'rev-1'
  );
  assert.equal(body.modified.length, 1);
  assert.equal(body.added.length, 1);
  assert.equal(body.modified[0].module[0], 1);
  // 5th argument present: the ancestor map up to the root (numeric keys
  // serialize in ascending order).
  assert.match(body.modified[0].module[1], /\{"0":\[\],"1":\[0\]\}\)/);
  // /gone.ts was never registered -> not in deleted; /index.ts (id 0) is.
  assert.deepEqual(body.deleted, [0]);
});

test('hot update against the REAL metro-runtime prelude re-runs the factory and refreshes', async (t) => {
  if (!preludeFile) {
    t.skip('no cached prelude (start reactnative-esm and fetch /prelude/<rnVersion> once)');
    return;
  }
  const prelude = fs.readFileSync(path.join(cacheDir, preludeFile), 'utf8');
  const registry = new ModuleIdRegistry();

  const entry = emitMetroModule(
    'var C = require("/app/home.tsx").default; globalThis.__RENDERED = C();',
    '/index.tsx',
    registry
  ).text;
  const compV1 = emitMetroModule(
    'function Home() { return "v1"; } exports.__esModule = true; exports.default = Home;',
    '/app/home.tsx',
    registry
  ).text;

  const update = buildMetroHmrBody(
    {
      updatedModules: {
        '/app/home.tsx':
          'function Home() { return "v2"; } exports.__esModule = true; exports.default = Home;',
      },
      removedModules: [],
      reverseDepsMap: { '/app/home.tsx': ['/index.tsx'], '/index.tsx': [] },
    },
    registry,
    'rev-t'
  );

  const script = `
    var global = globalThis; global.global = global;
    var __DEV__ = true; var __METRO_GLOBAL_PREFIX__ = '';
    global.__REFRESHED = false;
    global.__ReactRefresh = {
      isLikelyComponentType: (f) => typeof f === 'function' && /^[A-Z]/.test(f.name || ''),
      register() {},
      performReactRefresh() { global.__REFRESHED = true; },
      getFamilyByType() { return undefined; },
    };
    ${prelude}
    ${entry}
    ${compV1}
    __r(${registry.idFor('/index.tsx')});
    var before = globalThis.__RENDERED;
    ${update.modified[0].module[1]}
    // Re-render through the swapped module (metro-runtime re-ran the factory).
    var after = __r(${registry.idFor('/app/home.tsx')}).default();
    return { before, after };
  `;
  const result = new Function(script)();
  assert.equal(result.before, 'v1');
  assert.equal(result.after, 'v2');
  // performReactRefresh is scheduled on a deferred tick by metro-runtime.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(globalThis.__REFRESHED, true);
  delete globalThis.__RENDERED;
  delete globalThis.__REFRESHED;
  delete globalThis.__ReactRefresh;
});
