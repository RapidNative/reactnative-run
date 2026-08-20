import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { scanProject } from '../dist/project/scan.js';
import { watchProject } from '../dist/project/watch.js';
import { BundlerSession } from '../dist/bundler/session.js';
import { startServer } from '../dist/server/server.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plain-app');

let dir; // temp copy of the fixture (tests edit files on disk)
let session;
let dev;
let watcher;
let base;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-server-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

  const { files } = scanProject(dir);
  session = new BundlerSession(files, {
    // Never reached -- the fixture has no npm deps.
    packageServerUrl: 'http://127.0.0.1:0',
    env: { EXPO_PUBLIC_TEST: 'fixture' },
    platform: 'web',
    assetPublicPath: '/__bm_assets',
  });

  const nativeSessions = new Map();
  const ctx = {
    session,
    config: { app: { name: 'Plain App', slug: 'plain-app' }, env: {}, pkg: { dependencies: {} } },
    rootDir: dir,
    title: 'Plain App',
    port: 0,
    log: () => {},
    getPlatformSession: async (platform) => {
      if (platform !== 'ios' && platform !== 'android') return null;
      if (!nativeSessions.has(platform)) {
        const { files } = scanProject(dir);
        const native = new BundlerSession(files, {
          packageServerUrl: 'http://127.0.0.1:0',
          env: {},
          platform,
          assetPublicPath: '/__bm_assets',
        });
        nativeSessions.set(platform, native.build().then(() => native));
      }
      return nativeSessions.get(platform);
    },
  };
  dev = await startServer(ctx, '127.0.0.1');
  base = `http://127.0.0.1:${dev.port}`;

  const ok = await session.build();
  assert.equal(ok, true, `initial build failed: ${session.buildError}`);

  watcher = watchProject({
    rootDir: dir,
    vfsHas: (p) => session.getVfs().exists(p),
    debounceMs: 50,
    onFlush: async ({ changes }) => {
      if (changes.length) await session.applyChanges(changes);
    },
  });
  // Give chokidar a beat to arm.
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await watcher?.close();
  await dev?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET / with Accept text/html serves the shell with the ws bridge', async () => {
  const res = await fetch(base + '/', { headers: { Accept: 'text/html' } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /\/__hmr/);
  assert.match(body, /hmr-full-reload/);
  assert.match(body, /index\.bundle\?platform=web/);
  assert.match(body, /globalThis\.__DEV__ = true/);
});

test('GET /index.bundle serves the web bundle with fixture code', async () => {
  const res = await fetch(base + '/index.bundle?platform=web');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const body = await res.text();
  assert.match(body, /hello /);            // greet.ts made it in
  assert.match(body, /"\/lib\/greet\.ts"/); // module keyed by VFS path
  assert.match(body, /EXPO_PUBLIC_TEST/);   // env preamble injected
});

test('GET /status answers the Metro packager handshake', async () => {
  const res = await fetch(base + '/status');
  assert.equal(await res.text(), 'packager-status:running');
});

test('manifest: expo-platform header gets multipart with a STABLE scopeKey', async () => {
  const get = async () => {
    const res = await fetch(base + '/', {
      headers: { 'expo-platform': 'ios', Accept: 'multipart/mixed' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('expo-protocol-version'), '0');
    assert.match(res.headers.get('content-type'), /multipart\/mixed; boundary=/);
    const text = await res.text();
    const jsonPart = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(jsonPart);
  };
  const a = await get();
  const b = await get();
  assert.match(a.launchAsset.url, /index\.bundle\?platform=ios/);
  assert.equal(a.extra.expoClient.slug, 'plain-app');
  assert.ok(a.extra.scopeKey.startsWith('@anonymous/plain-app-'));
  assert.equal(a.extra.scopeKey, b.extra.scopeKey, 'scopeKey must be stable per project');
  assert.notEqual(a.id, b.id);
});

test('manifest: JSON fallback without multipart Accept', async () => {
  const res = await fetch(base + '/manifest?platform=android');
  assert.equal(res.status, 200);
  const manifest = await res.json();
  assert.match(manifest.launchAsset.url, /platform=android/);
});

test('ios bundle is served in Metro format (__d/__r) with the entry included', async () => {
  const res = await fetch(base + '/index.bundle?platform=ios');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /__registerSegment/);
  assert.match(body, /__r\(0\);/);
  assert.match(body, /"\/lib\/greet\.ts"/);
  // No web HMR runtime in a native bundle.
  assert.doesNotMatch(body, /__BUNDLER_HMR__/);
});

test('unknown native platform without a session factory would 501 (guard shape)', async () => {
  // The factory only handles ios/android; anything else falls through to 501.
  const res = await fetch(base + '/index.bundle?platform=windows');
  assert.equal(res.status, 501);
});

test('GET /__bm_assets streams bytes from disk', async () => {
  const res = await fetch(base + '/__bm_assets/icon.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf[0], 0x89);
  assert.equal(buf.length, 6);
});

test('asset path traversal is rejected', async () => {
  const res = await fetch(base + '/__bm_assets/..%2F..%2Fetc%2Fpasswd');
  assert.ok(res.status === 403 || res.status === 404);
});

// SPA deep-path fallback: a browser navigation (Accept: text/html) to a deep
// expo-router route must receive the SAME index.html as /, so the client
// router resolves the path. Assets and dev-server API paths must not fall back,
// and a request without text/html (bare tooling) must still 404.
test('SPA fallback: deep route with Accept text/html serves the index bytes', async () => {
  const index = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();

  for (const p of ['/login', '/nested/deep/route', '/settings/profile/']) {
    const res = await fetch(base + p, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 200, `${p} should fall back to index`);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(await res.text(), index, `${p} must be byte-identical to /`);
  }
});

test('SPA fallback: bare request (no text/html) still 404s, so real misses are not masked', async () => {
  const res = await fetch(base + '/login', { headers: { Accept: '*/*' } });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Not found: \/login/);
});

test('SPA fallback: assets and bundle are NOT fallback\'d even on a browser navigation', async () => {
  // /index.bundle keeps serving JS (owned by the bundle route, registered first).
  const bundle = await fetch(base + '/index.bundle?platform=web', { headers: { Accept: 'text/html' } });
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type'), /javascript/);

  // An extensioned path (asset shape) with no backing file 404s -- never index.
  const png = await fetch(base + '/does-not-exist.png', { headers: { Accept: 'text/html' } });
  assert.equal(png.status, 404);
});

test('SPA fallback: dev-server API paths keep current behavior (not index)', async () => {
  const index = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();
  // /status is native-owned regardless of Accept.
  const status = await fetch(base + '/status', { headers: { Accept: 'text/html' } });
  assert.equal(await status.text(), 'packager-status:running');
  // /manifest is matched by native only for Expo-looking requests; a plain
  // browser GET must NOT be handed the SPA index.
  const manifest = await fetch(base + '/manifest', { headers: { Accept: 'text/html' } });
  assert.notEqual(await manifest.text(), index, '/manifest must not fall back to index');
});

test('ws /__hmr: disk edit round-trips to an hmr-update frame', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${dev.port}/__hmr`);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // First frame is the hello handshake.
  const deadline0 = Date.now() + 2000;
  while (!frames.some((f) => f.type === 'hello') && Date.now() < deadline0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(frames.some((f) => f.type === 'hello'), 'hello frame');

  fs.writeFileSync(
    path.join(dir, 'lib/greet.ts'),
    'export function greet(name: string): string { return `hi ${name}`; }\n',
  );

  const deadline = Date.now() + 5000;
  while (!frames.some((f) => f.type === 'hmr-update' || f.type === 'reload') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const update = frames.find((f) => f.type === 'hmr-update' || f.type === 'reload');
  assert.ok(update, 'expected an hmr-update or reload frame after a disk edit');
  if (update.type === 'hmr-update') {
    assert.ok(update.updatedModules['/lib/greet.ts'], 'updated module payload for greet.ts');
    assert.match(update.updatedModules['/lib/greet.ts'], /hi /);
  }
  ws.close();
});

test('ws /hot: Metro handshake gets bundle-registered', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${dev.port}/hot`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const reply = new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(String(raw)))));
  ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [] }));
  const msg = await reply;
  assert.equal(msg.type, 'bundle-registered');
  ws.close();
});

test('the served bundle executes in Node and produces the fixture export', async () => {
  const res = await fetch(base + '/index.bundle?platform=web');
  const body = await res.text();
  // The HMR runtime references window/addEventListener; give it a minimal one.
  const sandbox = { console, setTimeout, globalThis: undefined };
  const windowStub = {
    addEventListener: () => {},
    parent: { postMessage: () => {} },
    postMessage: () => {},
  };
  const fn = new Function('window', 'globalThis', body + '\n');
  fn(windowStub, globalThis);
  // The HMR test above may have already rewritten greet.ts ("hello" -> "hi").
  assert.match(globalThis.__PLAIN_APP__, /^(hello|hi) world$/);
  delete globalThis.__PLAIN_APP__;
});
