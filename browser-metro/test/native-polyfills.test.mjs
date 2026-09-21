// Native prelude subpaths. Expo's winter runtime leaves ReadableStream to
// Metro ("ReadableStream is injected by Metro as a global"), so a native
// bundle for an Expo project must run expo/virtual/streams.js before the
// entry -- otherwise expo/fetch's `response.body` throws
// "Property 'ReadableStream' doesn't exist" on Hermes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_POLYFILL_SUBPATHS,
  EXPO_STREAMS_POLYFILL_SUBPATH,
  nativePostCoreSubpaths,
} from '../dist/utils.js';

test('expo projects run the streams polyfill after InitializeCore', () => {
  assert.deepEqual(nativePostCoreSubpaths({ expo: '57.0.24', 'react-native': '0.86.0' }), [
    EXPO_STREAMS_POLYFILL_SUBPATH,
  ]);
});

test('semver ranges resolve to their major', () => {
  for (const range of ['~57.0.0', '^53.0.0', '>=54.0.0']) {
    assert.deepEqual(nativePostCoreSubpaths({ expo: range }), [EXPO_STREAMS_POLYFILL_SUBPATH], range);
  }
});

test('expo below SDK 53 does not ship virtual/streams.js, so it is not requested', () => {
  assert.deepEqual(nativePostCoreSubpaths({ expo: '~52.0.0' }), []);
});

test('no expo, or an expo version with no readable major, requests nothing', () => {
  assert.deepEqual(nativePostCoreSubpaths({ 'react-native': '0.86.0' }), []);
  assert.deepEqual(nativePostCoreSubpaths({ expo: 'latest' }), []);
});

test('the streams polyfill is not a pre-InitializeCore polyfill', () => {
  // Requiring it evaluates the whole expo chunk, which needs the native
  // environment InitializeCore sets up.
  assert.ok(!NATIVE_POLYFILL_SUBPATHS.includes(EXPO_STREAMS_POLYFILL_SUBPATH));
});
