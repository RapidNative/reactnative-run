import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';

// CACHE_DIR is read when the module loads, so point it at a temp dir first.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-pkg-cache-'));
process.env.RNRUN_PKG_CACHE_DIR = cacheDir;
const { createCachedFetch } = await import('../dist/project/pkg-cache.js');

let server;
let base;
let requests = 0;

before(async () => {
  server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`// ${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('a disk hit serves the stored body without a request', async () => {
  const stats = { hits: 0, misses: 0 };
  const cachedFetch = createCachedFetch(stats);
  const url = `${base}/bundle-deps/0123456789abcdef`;
  assert.equal(await (await cachedFetch(url)).text(), '// /bundle-deps/0123456789abcdef');
  const before = requests;
  assert.equal(await (await cachedFetch(url)).text(), '// /bundle-deps/0123456789abcdef');
  assert.equal(requests, before);
  assert.deepEqual(stats, { hits: 1, misses: 1 });
});

test('a disk hit lets the event loop turn before it resolves', async () => {
  // A build fed entirely from disk must not starve the HTTP server: the Expo Go
  // manifest request waited out both pre-warm builds when hits resolved
  // without a macrotask turn.
  const cachedFetch = createCachedFetch();
  const url = `${base}/pkg/react@19.1.0`;
  await cachedFetch(url);
  let turned = false;
  setImmediate(() => (turned = true));
  await cachedFetch(url);
  assert.equal(turned, true);
});
