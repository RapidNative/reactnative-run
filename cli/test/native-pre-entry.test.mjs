import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_DEV_CLIENT_PATH,
  NATIVE_PRE_ENTRY_PATH,
  nativeEntryWrapperSource,
} from '../dist/bundler/native-dev-client.js';

test('native entry wrapper: dev client, then the app, when there is no pre-entry', () => {
  assert.equal(
    nativeEntryWrapperSource('/index.tsx'),
    `require(".${NATIVE_DEV_CLIENT_PATH}");\nrequire("./index.tsx");\n`,
  );
});

test('native entry wrapper: the pre-entry module runs after the dev client and before the app', () => {
  const src = nativeEntryWrapperSource('/index.tsx', NATIVE_PRE_ENTRY_PATH);
  const lines = src.trim().split('\n');
  assert.deepEqual(lines, [
    `require(".${NATIVE_DEV_CLIENT_PATH}");`,
    'require("./.rnrun/pre-entry.js");',
    'require("./index.tsx");',
  ]);
});
