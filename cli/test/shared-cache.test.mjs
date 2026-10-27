import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';

// Both directories are read when the modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-shared-cache-'));
const ownDir = path.join(root, 'own');
const sharedDir = path.join(root, 'shared');
process.env.RNRUN_PKG_CACHE_DIR = ownDir;
process.env.RNRUN_SHARED_CACHE_DIR = sharedDir;
const { createCachedFetch, fillSharedCache } = await import('../dist/project/pkg-cache.js');
const { resolveWorkletsPlugin } = await import('../dist/bundler/worklets.js');

let server;
let base;
let requests = [];

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/javascript', 'x-externals': 'react' });
    res.end(`// ${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const sharedFiles = () => fs.readdirSync(path.join(sharedDir, 'pkg')).sort();

test('fill stores immutable URLs only, whole files, once', async () => {
  const urls = [`${base}/bundle-deps/aaaaaaaaaaaaaaaa`, `${base}/pkg/react@19.1.0?platform=ios`, `${base}/pkg/react?platform=ios`];
  const first = await fillSharedCache(sharedDir, urls);
  assert.deepEqual(first, { stored: 2, present: 0, skipped: 1, failed: 0, deferred: 0, pruned: 0 });
  assert.equal(sharedFiles().length, 4, 'a body and a meta per entry, no temp files left');
  const again = await fillSharedCache(sharedDir, urls);
  assert.deepEqual(again, { stored: 0, present: 2, skipped: 1, failed: 0, deferred: 0, pruned: 0 });
});

test('maxNew stores the first entries listed and defers the rest', async () => {
  const dir = path.join(root, 'capped');
  const urls = ['1111111111111111', '2222222222222222', '3333333333333333'].map((h) => `${base}/bundle-deps/${h}`);
  const first = await fillSharedCache(dir, urls, { maxNew: 2 });
  assert.equal(first.stored, 2);
  assert.equal(first.deferred, 1);
  const next = await fillSharedCache(dir, urls, { maxNew: 2 });
  assert.deepEqual([next.present, next.stored, next.deferred], [2, 1, 0]);
});

test('a project reads a shared entry without a request and without copying it', async () => {
  const url = `${base}/bundle-deps/bbbbbbbbbbbbbbbb`;
  await fillSharedCache(sharedDir, [url]);
  requests = [];
  const res = await createCachedFetch()(url);
  assert.equal(await res.text(), '// /bundle-deps/bbbbbbbbbbbbbbbb');
  assert.equal(res.headers.get('x-externals'), 'react');
  assert.deepEqual(requests, []);
  assert.equal(fs.existsSync(ownDir), false, 'nothing written to the project disk');
});

test('a dependency-bundle POST is answered from the shared entry for its hash', async () => {
  await fillSharedCache(sharedDir, [`${base}/bundle-deps/cccccccccccccccc`]);
  requests = [];
  const res = await createCachedFetch()(`${base}/bundle-deps`, { method: 'POST', body: JSON.stringify({ hash: 'cccccccccccccccc' }) });
  assert.equal(await res.text(), '// /bundle-deps/cccccccccccccccc');
  assert.deepEqual(requests, []);
});

test('a versionless URL is never served from the shared cache', async () => {
  // Planted by hand: fill refuses to store one.
  const url = `${base}/pkg/react-dom?platform=ios`;
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(sharedDir, 'pkg', key + '.body'), 'stale');
  fs.writeFileSync(path.join(sharedDir, 'pkg', key + '.meta.json'), JSON.stringify({ url, status: 200, headers: {}, savedAt: Date.now(), cacheClass: 'versionless' }));
  requests = [];
  assert.equal(await (await createCachedFetch()(url)).text(), '// /pkg/react-dom?platform=ios');
  assert.equal(requests.length, 1);
});

test('prune drops old entries no longer listed, and keeps listed or recent ones', async () => {
  const dir = path.join(root, 'prune');
  const [oldGone, oldListed, recent] = ['dddddddddddddddd', 'eeeeeeeeeeeeeeee', 'ffffffffffffffff'].map((h) => `${base}/bundle-deps/${h}`);
  await fillSharedCache(dir, [oldGone, oldListed, recent]);
  const pkgDir = path.join(dir, 'pkg');
  for (const file of fs.readdirSync(pkgDir).filter((f) => f.endsWith('.meta.json'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, file), 'utf8'));
    if (meta.url !== recent) fs.writeFileSync(path.join(pkgDir, file), JSON.stringify({ ...meta, savedAt: Date.now() - 10 * 86400_000 }));
  }
  const result = await fillSharedCache(dir, [oldListed], { pruneDays: 7 });
  assert.equal(result.pruned, 1);
  const left = fs.readdirSync(pkgDir).filter((f) => f.endsWith('.meta.json')).map((f) => JSON.parse(fs.readFileSync(path.join(pkgDir, f), 'utf8')).url).sort();
  assert.deepEqual(left, [oldListed, recent].sort());
});

test('the worklets plugin is taken from the shared tool cache before any fetch', () => {
  const plugin = path.join(sharedDir, 'tools', 'worklets-9.9.9', 'react-native-worklets', 'plugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'index.js'), 'module.exports = function () { return { visitor: {} }; };');
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  const warnings = [];
  assert.equal(resolveWorkletsPlugin(project, { 'react-native-worklets': '9.9.9' }, (m) => warnings.push(m)), plugin);
  assert.deepEqual(warnings, [], 'no fetch attempted');
});
