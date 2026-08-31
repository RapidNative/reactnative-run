// Regression tests for pinning `react-dom` to the project's declared `react` version.
//
// The bug they lock in: react and react-dom must be the EXACT same version (react-dom throws
// "Incompatible React versions" at boot otherwise), but Expo projects declare `react` and not
// `react-dom` — on web it arrives transitively through react-native-web. The package server
// npm-installs react-native-web in isolation, so npm resolves its `react-dom` peer range to the
// newest matching release and `@externals` pins react-dom there. A project on react 19.1.0 rebuilt
// after react-dom 19.2.8 was published got react-dom@19.2.8 and died at boot with no project
// change of its own (rapidnative project 0lz1rKATxkJmDVso2OXhQ, 2026-08-31).
//
// The declared-react pin must therefore outrank the server-reported transitive version — which is
// what makes this bug different from the bare-specifier one rn-scoped-version.test.mjs covers.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';
import { reactDomVersionFor } from '../dist/utils.js';

/**
 * A bundler whose package fetches are recorded instead of performed.
 *
 * The user file imports `react-native-web` (declared), and the served body carries both the
 * transitive `require("react-dom/client")` and an `@externals` line reporting the version npm
 * resolved in the server's isolated install — exactly how the drifted version reaches the
 * bundler in production.
 */
function makeBundler(deps, packageBodies = {}) {
  const requested = [];
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: deps }));
  fs.write('/index.js', 'require("react-native-web");');

  const bundler = new IncrementalBundler(fs, {
    resolver: { sourceExts: ['js', 'ts', 'tsx', 'jsx'] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: 'http://127.0.0.1:0' },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    requested.push(u);
    // /bundle-deps (prefetch) must miss so each package takes the individual fetch path,
    // which is the one that resolves a specifier per package.
    if (u.includes('/bundle-deps')) return { ok: false, status: 404 };
    const spec = decodeURIComponent(u.split('/pkg/')[1] ?? '');
    const body = Object.entries(packageBodies).find(([name]) => spec.startsWith(name))?.[1];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => body ?? 'module.exports = {};',
    };
  };

  return {
    bundler,
    requested,
    restore: () => {
      globalThis.fetch = origFetch;
    },
  };
}

/** The specifier the bundler asked the package server for, e.g. "react-dom@19.1.0/client". */
function pkgRequest(requested, baseName) {
  const hit = requested.find((u) => u.includes('/pkg/' + baseName));
  return hit ? decodeURIComponent(hit.split('/pkg/')[1]) : null;
}

/** react-native-web as the server bundles it: react-dom externalized at npm's isolated
 *  peer resolution — newer than the project's declared react. */
const RNW_BODY =
  '// @externals {"react":"19.2.8","react-dom":"19.2.8"}\n' +
  'require("react-dom/client"); module.exports = {};';

test('transitive react-dom is pinned to the declared react, not the server-reported version', async () => {
  const { bundler, requested, restore } = makeBundler(
    // react is declared; react-dom is not, exactly as an Expo project looks.
    { react: '19.1.0', 'react-native-web': '0.21.0' },
    { 'react-native-web': RNW_BODY },
  );

  try {
    await bundler.build('/index.js');
  } finally {
    restore();
  }

  const asked = pkgRequest(requested, 'react-dom');
  assert.ok(asked, 'expected the bundler to request react-dom');
  assert.equal(
    asked,
    'react-dom@19.1.0/client',
    'react-dom must match the declared react exactly — 19.2.8 here is the version-mismatch boot crash',
  );
});

test('an explicitly declared react-dom still wins over the react fallback', async () => {
  const { bundler, requested, restore } = makeBundler(
    { react: '19.1.0', 'react-dom': '19.0.0', 'react-native-web': '0.21.0' },
    { 'react-native-web': RNW_BODY },
  );

  try {
    await bundler.build('/index.js');
  } finally {
    restore();
  }

  assert.equal(
    pkgRequest(requested, 'react-dom'),
    'react-dom@19.0.0/client',
    'package.json must stay the highest-priority source',
  );
});

test('a version range is passed through so both packages resolve from the same range', () => {
  assert.equal(reactDomVersionFor('react-dom', { react: '^19.1.0' }), '^19.1.0');
});

test('other packages are untouched', () => {
  const versions = { react: '19.1.0' };
  // react-dom is the only package with react's exact-match contract; borrowing react's
  // version elsewhere would invent releases that don't exist.
  assert.equal(reactDomVersionFor('react', versions), undefined);
  assert.equal(reactDomVersionFor('scheduler', versions), undefined);
  assert.equal(reactDomVersionFor('react-native-web', versions), undefined);
});

test('no react declared leaves the specifier alone', () => {
  // A project without react has nothing to pin to; bare stays bare.
  assert.equal(reactDomVersionFor('react-dom', { lodash: '4.17.21' }), undefined);
});
