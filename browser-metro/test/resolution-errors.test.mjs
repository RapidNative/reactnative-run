// Regression tests for assertDeclaredNpmDeps' subpath-peer enforcement.
//
// The bug they lock in: importing a navigator subpath whose base package IS
// declared but whose extra peer is NOT (e.g. `expo-router/drawer` needs
// `@react-navigation/drawer`) used to pass the base-only declaration check and
// then boot into a cryptic expo-router runtime crash. The bundler must instead
// fail fast with a Metro-style "Unable to resolve" error naming the missing
// peer, attributed to the importing file.
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
  // Never reached for these tests — the resolution error throws during the file
  // walk, before any package fetch.
  server: { packageServerUrl: 'http://127.0.0.1:0' },
};

/** Build a one-screen project whose _layout imports the Drawer navigator. */
function makeBundler({ declarePeer }) {
  const deps = { 'expo-router': '^4.0.0' };
  if (declarePeer) deps['@react-navigation/drawer'] = '^7.0.0';
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: deps }));
  fs.write(
    '/app/_layout.tsx',
    `import { Drawer } from 'expo-router/drawer';\nexport default function Layout() { return <Drawer />; }\n`,
  );
  return new IncrementalBundler(fs, CONFIG);
}

test('expo-router/drawer without @react-navigation/drawer → clear resolution error', async () => {
  const bundler = makeBundler({ declarePeer: false });
  await assert.rejects(
    () => bundler.build('/app/_layout.tsx'),
    (e) =>
      /^Unable to resolve "@react-navigation\/drawer" from "app\/_layout\.tsx"/.test(e.message) &&
      /required by "expo-router\/drawer"/.test(e.message),
  );
});

test('expo-router/drawer WITH @react-navigation/drawer declared → no peer-resolution error', async () => {
  const bundler = makeBundler({ declarePeer: true });
  // The build may still fail later for unrelated reasons (no reachable package
  // server), but it must NOT throw the subpath-peer resolution error.
  try {
    await bundler.build('/app/_layout.tsx');
  } catch (e) {
    assert.ok(
      !/required by "expo-router\/drawer"/.test(e.message),
      `unexpected peer-resolution error when peer IS declared: ${e.message}`,
    );
  }
});
