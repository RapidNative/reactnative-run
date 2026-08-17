// Metro-format emission (Milestone A: single-__d wrapper).
// These tests EXECUTE the emitted bundle in a sandbox rather than snapshotting
// strings: what matters is the Expo Go boot contract (__d/__r/__c/
// __registerSegment exist, __r(0) runs the app, preRequires run before entry).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitMetroWrappedBundle } from '../dist/metro-emit.js';
import { hashDeps } from '../dist/utils.js';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';

function run(bundle) {
  // Fresh "Hermes-like" global: no window, no document. The prelude/runtime
  // attach __d/__r to globalThis of the sandbox function scope.
  const sandbox = {
    console,
    Date,
    process: undefined,
    order: [],
  };
  sandbox.globalThis = sandbox;
  const fn = new Function('globalThis', `with (globalThis) { ${bundle} }`);
  fn(sandbox);
  return sandbox;
}

test('emitted bundle defines the Metro boot contract and runs the entry', () => {
  const bundle = emitMetroWrappedBundle(
    {
      // __DEV__/process are script-scope vars in the emitted bundle; module
      // factories see them, so observe them from inside (the sandbox's `with`
      // wrapper can't -- real Hermes top-level `var` IS global).
      '/index.js':
        'globalThis.order.push("entry", String(__DEV__), process.env.NODE_ENV); module.exports = require("/lib").x;',
      '/lib': 'globalThis.order.push("lib"); module.exports = { x: 42 };',
    },
    '/index.js',
    {}
  );
  const g = run(bundle);
  assert.equal(typeof g.__d, 'function');
  assert.equal(typeof g.__r, 'function');
  assert.equal(typeof g.__registerSegment, 'function');
  assert.deepEqual(g.order, ['entry', 'true', 'development', 'lib']);
});

test('preRequires run before the entry (InitializeCore ordering)', () => {
  const bundle = emitMetroWrappedBundle(
    {
      '/index.js': 'globalThis.order.push("entry");',
      'react-native/Libraries/Core/InitializeCore': 'globalThis.order.push("init");',
    },
    '/index.js',
    { preRequires: ['react-native/Libraries/Core/InitializeCore'] }
  );
  const g = run(bundle);
  assert.deepEqual(g.order, ['init', 'entry']);
});

test('a throwing module re-throws the same error on re-require', () => {
  const bundle = emitMetroWrappedBundle(
    { '/index.js': 'globalThis.order.push("ran"); throw new Error("boom");' },
    '/index.js',
    {}
  );
  assert.throws(() => run(bundle), /boom/);
});

test('EXPO_PUBLIC env vars land in the prelude, others are excluded', () => {
  const bundle = emitMetroWrappedBundle({ '/index.js': '' }, '/index.js', {
    env: { EXPO_PUBLIC_API: 'https://x', SECRET_TOKEN: 'nope' },
  });
  assert.match(bundle, /EXPO_PUBLIC_API/);
  assert.doesNotMatch(bundle, /SECRET_TOKEN/);
});

test('hashDeps: web/absent platform is byte-identical to the historical hash; native differs per platform', async () => {
  const deps = { react: '19.1.0', 'react-native': '0.81.4' };
  const subs = ['react/jsx-runtime'];
  const legacy = await hashDeps(deps, subs);
  assert.equal(await hashDeps(deps, subs, 'web'), legacy);
  assert.equal(await hashDeps(deps, subs, undefined), legacy);
  const ios = await hashDeps(deps, subs, 'ios');
  const android = await hashDeps(deps, subs, 'android');
  assert.notEqual(ios, legacy);
  assert.notEqual(android, legacy);
  assert.notEqual(ios, android);
});

test('IncrementalBundler emits metro format when configured, iife by default', async () => {
  const make = async (output) => {
    const fs = new VirtualFS({});
    fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    fs.write('/index.ts', 'export const x = 1;');
    const b = new IncrementalBundler(fs, {
      resolver: { sourceExts: ['ts', 'tsx', 'js', 'jsx'] },
      transformer: typescriptTransformer,
      server: { packageServerUrl: 'http://127.0.0.1:0' },
      ...(output ? { output } : {}),
    });
    const result = await b.build('/index.ts');
    return result.bundle;
  };

  const iife = await make(undefined);
  assert.doesNotMatch(iife, /__registerSegment/);

  const metro = await make({ format: 'metro' });
  assert.match(metro, /__registerSegment/);
  assert.match(metro, /__r\(0\);/);
  // No web-isms in a native bundle.
  assert.doesNotMatch(metro, /window\.__BUNDLER_HMR__/);
});
