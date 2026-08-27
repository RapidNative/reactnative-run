import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { mergeHistory } from '../dist/bundler/catch-up.js';
import { ClientRegistry, clientTokenFromUrl, platformFromUrl } from '../dist/server/clients.js';
import { scanProject } from '../dist/project/scan.js';
import { BundlerSession } from '../dist/bundler/session.js';
import { startServer } from '../dist/server/server.js';

// ---------------------------------------------------------------------------
// mergeHistory: the catch-up patch for a device that missed rebuilds.
// ---------------------------------------------------------------------------
const upd = (updated, removed = [], reverse = {}) => ({
  updatedModules: updated,
  removedModules: removed,
  requiresReload: false,
  reverseDepsMap: reverse,
});

test('mergeHistory: current client gets an empty patch', () => {
  const m = mergeHistory([{ version: 3, update: upd({ '/a': 'a3' }) }], 3, 3);
  assert.deepEqual(m.updatedModules, {});
  assert.deepEqual(m.removedModules, []);
});

test('mergeHistory: folds consecutive updates, later code wins', () => {
  const history = [
    { version: 2, update: upd({ '/a': 'a2' }) },
    { version: 3, update: upd({ '/a': 'a3', '/b': 'b3' }, [], { '/b': ['/a'] }) },
    { version: 4, update: upd({ '/c': 'c4' }) },
  ];
  const m = mergeHistory(history, 1, 4);
  assert.deepEqual(m.updatedModules, { '/a': 'a3', '/b': 'b3', '/c': 'c4' });
  assert.deepEqual(m.reverseDepsMap, { '/b': ['/a'] });
});

test('mergeHistory: removed-then-added lands as updated; added-then-removed as removed', () => {
  const history = [
    { version: 2, update: upd({ '/x': 'x2' }, ['/y']) },
    { version: 3, update: upd({ '/y': 'y3' }, ['/x']) },
  ];
  const m = mergeHistory(history, 1, 3);
  assert.deepEqual(m.updatedModules, { '/y': 'y3' });
  assert.deepEqual(m.removedModules, ['/x']);
});

test('mergeHistory: a full rebuild in between, a trimmed history, or a client ahead → null', () => {
  assert.equal(mergeHistory([{ version: 2, update: upd({ '/a': 'a' }) }, { version: 3, update: null }], 1, 3), null);
  // history starts at 5; a client at 2 can't be reached
  assert.equal(mergeHistory([{ version: 5, update: upd({ '/a': 'a' }) }], 2, 5), null);
  // history doesn't reach the current version
  assert.equal(mergeHistory([{ version: 2, update: upd({ '/a': 'a' }) }], 1, 3), null);
  assert.equal(mergeHistory([], 4, 3), null);
});

// ---------------------------------------------------------------------------
// ClientRegistry + URL helpers
// ---------------------------------------------------------------------------
test('client token and platform are read from a bundle URL', () => {
  const url = 'http://10.0.0.5:8081/index.bundle?platform=ios&dev=true&rnrunClient=abc123';
  assert.equal(clientTokenFromUrl(url), 'abc123');
  assert.equal(platformFromUrl(url), 'ios');
  assert.equal(clientTokenFromUrl('http://x/index.bundle?platform=ios'), null);
  assert.equal(clientTokenFromUrl(undefined), null);
  assert.equal(clientTokenFromUrl('not a url'), null);
});

test('ClientRegistry: latest record wins and the map stays bounded', () => {
  const reg = new ClientRegistry();
  reg.record('t1', { platform: 'ios', epoch: 'e1', version: 1 });
  reg.record('t1', { platform: 'ios', epoch: 'e1', version: 2 });
  assert.equal(reg.get('t1').version, 2);
  assert.equal(reg.get('nope'), null);
  for (let i = 0; i < 400; i++) reg.record(`k${i}`, { platform: 'ios', epoch: 'e', version: 1 });
  assert.ok(reg.size() <= 256);
  assert.equal(reg.get('t1'), null, 'oldest entries are evicted first');
});

// ---------------------------------------------------------------------------
// Server: the manifest mints a token, the bundle route records it, /hot and
// /__rnrun act on it.
// ---------------------------------------------------------------------------
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plain-app');

let dir, dev, base, ctx;
const nativeSessions = new Map();

function makeNative(platform) {
  const { files } = scanProject(dir);
  const native = new BundlerSession(files, {
    packageServerUrl: 'http://127.0.0.1:0',
    env: {},
    platform,
    assetPublicPath: '/__bm_assets',
  });
  nativeSessions.set(platform, native);
  return native;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-native-sync-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const { files } = scanProject(dir);
  const session = new BundlerSession(files, {
    packageServerUrl: 'http://127.0.0.1:0',
    env: {},
    platform: 'web',
    assetPublicPath: '/__bm_assets',
  });
  const native = makeNative('ios');
  await native.build();
  ctx = {
    session,
    config: { app: { name: 'Plain App', slug: 'plain-app' }, env: {}, pkg: { dependencies: {} } },
    rootDir: dir,
    title: 'Plain App',
    port: 0,
    log: () => {},
    getPlatformSession: async (platform) => nativeSessions.get(platform) ?? null,
    peekPlatformSession: (platform) => nativeSessions.get(platform) ?? null,
  };
  dev = await startServer(ctx, '127.0.0.1');
  base = `http://127.0.0.1:${dev.port}`;
});

after(async () => {
  await dev?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function manifestBundleUrl() {
  const res = await fetch(base + '/', { headers: { 'expo-platform': 'ios', accept: 'application/expo+json' } });
  const manifest = await res.json();
  return manifest.launchAsset.url;
}

function frames(ws, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const out = [];
    const t = setTimeout(() => reject(new Error(`only ${out.length}/${count} frames: ${JSON.stringify(out)}`)), timeoutMs);
    ws.on('message', (raw) => {
      out.push(JSON.parse(String(raw)));
      if (out.length >= count) {
        clearTimeout(t);
        resolve(out);
      }
    });
  });
}

function open(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

test('manifest mints a client token; serving the bundle records it', async () => {
  const url = await manifestBundleUrl();
  const token = clientTokenFromUrl(url);
  assert.ok(token, 'launchAsset.url carries rnrunClient');
  assert.equal(ctx.clients.get(token), null, 'nothing recorded before the bundle is served');
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const rec = ctx.clients.get(token);
  assert.ok(rec);
  assert.equal(rec.platform, 'ios');
  assert.equal(rec.epoch, nativeSessions.get('ios').epoch);
  assert.equal(rec.version, nativeSessions.get('ios').bundleVersion);
});

test('/hot: a current device gets an empty initial update and no reload', async () => {
  const url = await manifestBundleUrl();
  await fetch(url);
  const msg = new WebSocket(base.replace('http', 'ws') + '/message');
  await open(msg);
  let reloads = 0;
  msg.on('message', (raw) => { if (JSON.parse(String(raw)).method === 'reload') reloads++; });

  const hot = new WebSocket(base.replace('http', 'ws') + '/hot');
  await open(hot);
  const got = frames(hot, 4);
  hot.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [url] }));
  const [registered, start, update, done] = await got;
  assert.equal(registered.type, 'bundle-registered');
  assert.equal(start.body.isInitialUpdate, true);
  assert.equal(update.type, 'update');
  assert.deepEqual(update.body.modified, []);
  assert.deepEqual(update.body.added, []);
  assert.equal(done.type, 'update-done');
  await new Promise((r) => setTimeout(r, 3300)); // past DEV_CLIENT_GRACE_MS
  assert.equal(reloads, 0);
  hot.close();
  msg.close();
});

test('/__rnrun: a device whose bundle came from another dev server is told to reload', async () => {
  // A token this process never served (e.g. minted before a restart).
  const ws = new WebSocket(base.replace('http', 'ws') + '/__rnrun?token=stale-token&platform=ios');
  const firstFirst = frames(ws, 1);
  await open(ws);
  const [first] = await firstFirst;
  assert.equal(first.type, 'reload');
  ws.close();
});

test('/__rnrun: a device on the current bundle just gets hello', async () => {
  const url = await manifestBundleUrl();
  await fetch(url);
  const token = clientTokenFromUrl(url);
  const ws = new WebSocket(base.replace('http', 'ws') + `/__rnrun?token=${token}&platform=ios`);
  const firstFirst = frames(ws, 1);
  await open(ws);
  const [first] = await firstFirst;
  assert.equal(first.type, 'hello');
  ws.close();
});

test('/__rnrun: a device from a previous bundler session (re-init) is told to reload', async () => {
  const url = await manifestBundleUrl();
  await fetch(url);
  const token = clientTokenFromUrl(url);
  // Re-init: the platform is now served from a fresh session (new epoch).
  const fresh = makeNative('ios');
  await fresh.build();
  const ws = new WebSocket(base.replace('http', 'ws') + `/__rnrun?token=${token}&platform=ios`);
  const firstFirst = frames(ws, 1);
  await open(ws);
  const [first] = await firstFirst;
  assert.equal(first.type, 'reload');
  ws.close();
});

test('/hot: a device that fell behind by an unpatchable rebuild is reloaded via its dev client', async () => {
  const url = await manifestBundleUrl();
  await fetch(url);
  const token = clientTokenFromUrl(url);
  const native = nativeSessions.get('ios');
  // Without a metro prelude this fixture's rebuilds are full ones (no HMR
  // payload), which is exactly the "can't be patched" case.
  fs.writeFileSync(path.join(dir, 'lib/greet.ts'), 'export const greet = (n: string) => `later, ${n}`;\n');
  await native.applyChanges([{ type: 'update', path: '/lib/greet.ts', content: fs.readFileSync(path.join(dir, 'lib/greet.ts'), 'utf8') }]);
  assert.ok(native.bundleVersion > ctx.clients.get(token).version, 'the device is behind');

  const devClient = new WebSocket(base.replace('http', 'ws') + `/__rnrun?token=${token}&platform=ios`);
  const helloFirst = frames(devClient, 1);
  await open(devClient);
  const [hello] = await helloFirst;
  assert.equal(hello.type, 'reload', 'behind and unpatchable: reload on connect');

  // A fresh dev-client connection AFTER re-fetching the bundle is current again.
  await fetch(url);
  const devClient2 = new WebSocket(base.replace('http', 'ws') + `/__rnrun?token=${token}&platform=ios`);
  const hello2First = frames(devClient2, 1);
  await open(devClient2);
  const [hello2] = await hello2First;
  assert.equal(hello2.type, 'hello');
  devClient.close();
  devClient2.close();
});

test('/hot: without a dev client the stale device falls back to a /message reload broadcast', async () => {
  const url = await manifestBundleUrl();
  await fetch(url);
  const native = nativeSessions.get('ios');
  fs.writeFileSync(path.join(dir, 'lib/greet.ts'), 'export const greet = (n: string) => `again, ${n}`;\n');
  await native.applyChanges([{ type: 'update', path: '/lib/greet.ts', content: fs.readFileSync(path.join(dir, 'lib/greet.ts'), 'utf8') }]);

  const msg = new WebSocket(base.replace('http', 'ws') + '/message');
  await open(msg);
  const reload = frames(msg, 1, 5000);
  const hot = new WebSocket(base.replace('http', 'ws') + '/hot');
  await open(hot);
  hot.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [url] }));
  const [frame] = await reload;
  assert.equal(frame.method, 'reload');
  hot.close();
  msg.close();
});
