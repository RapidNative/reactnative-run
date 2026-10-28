import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-platforms-'));
process.env.RNRUN_BUNDLE_CACHE_DIR = cacheDir;
const { seenPlatforms, rememberPlatform, prewarmPlan } = await import('../dist/project/platform-history.js');

test('android:seen is built only once a device has asked for android', () => {
  assert.deepEqual(prewarmPlan('ios,android:seen', new Set()), { build: ['ios'], skipped: ['android'], named: ['ios', 'android'], web: false });
  assert.deepEqual(prewarmPlan('ios,android:seen', new Set(['android'])).build, ['ios', 'android']);
  assert.deepEqual(prewarmPlan('ios,android', new Set()).build, ['ios', 'android']);
  assert.deepEqual(prewarmPlan(' IOS , web, tvos, android:later', new Set()), { build: ['ios'], skipped: [], named: ['ios'], web: true });
  assert.deepEqual(prewarmPlan(undefined, new Set()), { build: [], skipped: [], named: [], web: false });
});

test('the history is per project and survives a restart', () => {
  const a = path.join(cacheDir, 'project-a');
  const b = path.join(cacheDir, 'project-b');
  const seen = seenPlatforms(a);
  assert.equal(seen.size, 0);
  rememberPlatform(a, seen, 'android');
  rememberPlatform(a, seen, 'android');
  assert.deepEqual([...seenPlatforms(a)], ['android'], 'read back as a fresh process would');
  assert.equal(seenPlatforms(b).size, 0, 'another project in the same cache dir is unaffected');
  assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.tmp')).length, 0);
});
