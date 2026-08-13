// Regression tests for pinning `@react-native/*` packages to react-native core's version.
//
// The bug they lock in: these scoped packages are almost never direct dependencies (they arrive
// under expo / expo-asset / react-native itself), and the package server externalizes them WITHOUT
// reporting a version — for RN/Expo builds it strips `@react-native/*` out of the externals list
// before the branch that records versions runs, so `X-Externals` comes back `{}`. With no version
// from either source the specifier stayed bare, which the server resolves as `@latest`.
//
// That silently followed npm across a major RN release: @react-native/assets-registry@0.87.0
// (2026-08-11) rewrote registry.js into `require('react-native').AssetRegistry.registerAsset`, and
// on web `react-native` is aliased to react-native-web, which has no top-level `AssetRegistry`.
// Every project that rebuilt after that date died on "Cannot read properties of undefined (reading
// 'registerAsset')" with no project change of its own.
//
// These assert on the URL the bundler actually requests, not on the helper in isolation — the
// failure was a missing pin reaching the network, so the network call is what has to be pinned.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';
import { rnCoreVersionFor } from '../dist/utils.js';

/**
 * A bundler whose package fetches are recorded instead of performed.
 *
 * The user file imports `expo-asset` (declared), and the served expo-asset body contains the
 * transitive `require("@react-native/assets-registry/registry")` — which is how this reaches the
 * bundler in production. It is deliberately NOT a direct import from user source: those are
 * rejected up front by assertDeclaredNpmDeps unless declared, so a direct import could never have
 * produced this bug.
 */
function makeBundler(deps, packageBodies = {}) {
  const requested = [];
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: deps }));
  fs.write('/index.js', 'require("expo-asset");');

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
      // X-Externals empty, mirroring what the server actually returns for expo-asset —
      // that missing manifest entry is the reason there was no version to fall back to.
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

/** The specifier the bundler asked the package server for, e.g. "@react-native/assets-registry@0.81.4/registry". */
function pkgRequest(requested, baseName) {
  const hit = requested.find((u) => u.includes('/pkg/' + baseName));
  return hit ? decodeURIComponent(hit.split('/pkg/')[1]) : null;
}

/** expo-asset as the server bundles it: the assets-registry require left external. */
const EXPO_ASSET_BODY = 'require("@react-native/assets-registry/registry"); module.exports = {};';

test('a transitive @react-native/* dep is pinned to react-native core, not left bare', async () => {
  const { bundler, requested, restore } = makeBundler(
    // react-native is declared; assets-registry is not, exactly as a real project looks.
    { 'react-native': '0.81.4', 'expo-asset': '~12.0.9' },
    { 'expo-asset': EXPO_ASSET_BODY },
  );

  try {
    await bundler.build('/index.js');
  } finally {
    restore();
  }

  const asked = pkgRequest(requested, '@react-native/assets-registry');
  assert.ok(asked, 'expected the bundler to request @react-native/assets-registry');
  assert.equal(
    asked,
    '@react-native/assets-registry@0.81.4/registry',
    'a bare specifier here is resolved as @latest by the server — the 0.87.0 registerAsset crash',
  );
});

test('a version range is passed through so the pin follows the project RN line', () => {
  // The server resolves ranges the same way it does for any other dependency, so a project on
  // ~0.81.4 stays on its own line rather than being frozen to one exact release.
  assert.equal(rnCoreVersionFor('@react-native/assets-registry', { 'react-native': '~0.81.4' }), '~0.81.4');
});

test('an explicitly declared version still wins over the react-native fallback', async () => {
  const { bundler, requested, restore } = makeBundler(
    { 'react-native': '0.81.4', 'expo-asset': '~12.0.9', '@react-native/assets-registry': '0.79.0' },
    { 'expo-asset': EXPO_ASSET_BODY },
  );

  try {
    await bundler.build('/index.js');
  } finally {
    restore();
  }

  assert.equal(
    pkgRequest(requested, '@react-native/assets-registry'),
    '@react-native/assets-registry@0.79.0/registry',
    'package.json must stay the highest-priority source',
  );
});

test('non-@react-native scopes are untouched', () => {
  const versions = { 'react-native': '0.81.4' };
  // @react-navigation and @expo are versioned independently of RN core; borrowing core's
  // version would invent a release that does not exist.
  assert.equal(rnCoreVersionFor('@react-navigation/native', versions), undefined);
  assert.equal(rnCoreVersionFor('@expo/vector-icons', versions), undefined);
  assert.equal(rnCoreVersionFor('lodash', versions), undefined);
});

test('no react-native declared leaves the specifier alone', () => {
  // A plain web project has no RN line to borrow; inventing one would be worse than @latest.
  assert.equal(rnCoreVersionFor('@react-native/assets-registry', { react: '19.0.0' }), undefined);
});
