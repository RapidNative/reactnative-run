import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { diffPending, watchProject } from '../dist/project/watch.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-watch-'));
}

test('diffPending classifies create/update/delete against the VFS', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'existing.ts'), 'v2');
  fs.writeFileSync(path.join(dir, 'brand-new.ts'), 'v1');

  const vfs = new Set(['/existing.ts', '/gone.ts']);
  const pending = new Set(['/existing.ts', '/brand-new.ts', '/gone.ts']);
  const result = diffPending(dir, pending, (p) => vfs.has(p));

  const byPath = Object.fromEntries(result.changes.map((c) => [c.path, c]));
  assert.equal(byPath['/existing.ts'].type, 'update');
  assert.equal(byPath['/existing.ts'].content, 'v2');
  assert.equal(byPath['/brand-new.ts'].type, 'create');
  assert.equal(byPath['/gone.ts'].type, 'delete');
  assert.equal(result.needsReinit, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diffPending flags config files for re-init and routes assets separately', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'icon.png'), 'x');

  const result = diffPending(dir, new Set(['/package.json', '/icon.png']), () => true);
  assert.equal(result.needsReinit, true);
  assert.deepEqual(result.assetChanges, ['/icon.png']);
  // The asset is NOT in the text-change list.
  assert.equal(result.changes.some((c) => c.path === '/icon.png'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.env and app.config.js changes also trigger re-init', () => {
  const dir = tempDir();
  for (const f of ['.env', '.env.local', 'app.config.js', 'tsconfig.json']) {
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  const result = diffPending(
    dir,
    new Set(['/.env', '/.env.local', '/app.config.js', '/tsconfig.json']),
    () => true,
  );
  assert.equal(result.needsReinit, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchProject delivers a debounced flush for a real disk write', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'v1');

  const flushes = [];
  const watcher = watchProject({
    rootDir: dir,
    vfsHas: (p) => p === '/a.ts',
    debounceMs: 50,
    onFlush: async (result) => {
      flushes.push(result);
    },
  });

  // chokidar needs a beat to arm its watchers before the write.
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'v2');

  // macOS fsevents may replay the pre-watch v1 write as an extra early flush,
  // so wait for the flush that actually carries v2.
  const findV2 = () =>
    flushes.flatMap((f) => f.changes).find((c) => c.path === '/a.ts' && c.content === 'v2');
  const deadline = Date.now() + 4000;
  while (!findV2() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await watcher.close();

  const change = findV2();
  assert.ok(change, 'expected a flush carrying the v2 update');
  assert.equal(change.type, 'update');
  fs.rmSync(dir, { recursive: true, force: true });
});
