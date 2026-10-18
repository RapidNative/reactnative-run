// Regression tests for pinning undeclared `expo-*` packages to the project's Expo SDK line.
//
// The bug they lock in: expo-font requires `expo-asset` without declaring it, so the package server
// (which builds expo-font in isolation) has no version for it in `X-Externals`, and expo's own
// externals don't list it either. With no version from any source the specifier stayed bare, which
// the server resolves as `@latest`.
//
// That followed npm into the next SDK: expo-asset@58.0.16 (2026-10-15) imports
// `expo/internal/bundle-origin`, which expo 57 does not have, so the server answered HTTP 500
// "Could not resolve expo/internal/bundle-origin" and SDK 57 previews failed to build with no
// project change of their own.
//
// Like rn-scoped-version.test.mjs, these assert on the URL the bundler actually requests.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';
import { expoSdkVersionFor } from '../dist/utils.js';

/**
 * A bundler whose package fetches are recorded instead of performed. The user file imports
 * `expo-font` (declared); the served expo-font body requires `expo-asset`, exactly as the real one
 * does, so expo-asset reaches the bundler as a transitive, undeclared package.
 */
function makeBundler(deps, packageBodies = {}) {
  const requested = [];
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: deps }));
  fs.write('/index.js', 'require("expo-font");');

  const bundler = new IncrementalBundler(fs, {
    resolver: { sourceExts: ['js', 'ts', 'tsx', 'jsx'] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: 'http://127.0.0.1:0' },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    requested.push(u);
    // /bundle-deps must miss so each package takes the individual fetch path, the one that
    // resolves a specifier per package and the one the incident went through.
    if (u.includes('/bundle-deps')) return { ok: false, status: 404 };
    const spec = decodeURIComponent(u.split('/pkg/')[1] ?? '');
    const body = Object.entries(packageBodies).find(([name]) => spec.startsWith(name))?.[1];
    return {
      ok: true,
      status: 200,
      // X-Externals empty, as the server returns it for expo-font: no expo-asset version.
      headers: { get: () => null },
      text: async () => body ?? 'module.exports = {};',
    };
  };

  return { bundler, requested, restore: () => { globalThis.fetch = origFetch; } };
}

function pkgRequest(requested, baseName) {
  const hit = requested.find((u) => u.includes('/pkg/' + baseName + '@') || u.endsWith('/pkg/' + baseName));
  return hit ? decodeURIComponent(hit.split('/pkg/')[1]) : null;
}

const EXPO_FONT_BODY = 'require("expo-asset"); module.exports = {};';

test('an undeclared expo-asset is pinned to the project SDK line, not left bare', async () => {
  const { bundler, requested, restore } = makeBundler(
    { expo: '~57.0.19', 'expo-font': '~57.0.3' },
    { 'expo-font': EXPO_FONT_BODY },
  );
  try {
    await bundler.build('/index.js');
  } finally {
    restore();
  }
  assert.equal(
    pkgRequest(requested, 'expo-asset'),
    'expo-asset@^57.0.0',
    'a bare specifier here is resolved as @latest by the server: the SDK 58 bundle-origin 500',
  );
});

test('an explicitly declared version still wins over the SDK line', async () => {
  const { bundler, requested, restore } = makeBundler(
    { expo: '~57.0.19', 'expo-font': '~57.0.3', 'expo-asset': '~57.0.20' },
    { 'expo-font': EXPO_FONT_BODY },
  );
  try {
    await bundler.build('/index.js');
  } finally {
    restore();
  }
  assert.equal(pkgRequest(requested, 'expo-asset'), 'expo-asset@~57.0.20');
});

test('the SDK major is read from exact versions and ranges', () => {
  for (const expo of ['57.0.19', '^57.0.19', '~57.0.19', '=57.0.19', 'v57.1.0']) {
    assert.equal(expoSdkVersionFor('expo-asset', { expo }), '^57.0.0', expo);
  }
  assert.equal(expoSdkVersionFor('expo-constants', { expo: '^55.0.4' }), '^55.0.0');
});

test('the SDK-aligned @expo packages are pinned; the rest of @expo is not', () => {
  const versions = { expo: '^57.0.19' };
  assert.equal(expoSdkVersionFor('@expo/metro-runtime', versions), '^57.0.0');
  assert.equal(expoSdkVersionFor('@expo/log-box', versions), '^57.0.0');
  assert.equal(expoSdkVersionFor('@expo/ui', versions), '^57.0.0');
  // Versioned independently of the SDK: borrowing 57 would invent a release that does not exist.
  assert.equal(expoSdkVersionFor('@expo/vector-icons', versions), undefined);
  assert.equal(expoSdkVersionFor('@expo/metro', versions), undefined);
  assert.equal(expoSdkVersionFor('@expo/html-elements', versions), undefined);
});

test('expo itself and unrelated packages are untouched', () => {
  const versions = { expo: '^57.0.19' };
  assert.equal(expoSdkVersionFor('expo', versions), undefined);
  assert.equal(expoSdkVersionFor('lodash', versions), undefined);
  assert.equal(expoSdkVersionFor('react-native', versions), undefined);
});

test('SDKs before 55, tags and missing expo leave the specifier alone', () => {
  // expo 54 ships expo-asset 12.x: majors are not aligned before SDK 55.
  assert.equal(expoSdkVersionFor('expo-asset', { expo: '54.0.13' }), undefined);
  assert.equal(expoSdkVersionFor('expo-asset', { expo: 'latest' }), undefined);
  assert.equal(expoSdkVersionFor('expo-asset', { expo: 'next' }), undefined);
  assert.equal(expoSdkVersionFor('expo-asset', { react: '19.2.3' }), undefined);
});
