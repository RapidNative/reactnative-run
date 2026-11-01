import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { scanProject } from '../dist/project/scan.js';
import { BundlerSession } from '../dist/bundler/session.js';
import { startServer } from '../dist/server/server.js';
import { clientTokenFromUrl } from '../dist/server/clients.js';

// Fast Refresh for Expo Go's anonymous mode, where the dev client applies
// patches itself and a reload can't fetch new code: a device has to stay
// patchable across a restart that serves the cached bundle, and is never told
// to reload.

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plain-app');
// Any prelude makes the session emit per-module __d and HMR payloads.
const PRELUDE = '/* metro-runtime stand-in */\n';

let root, dir;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-anon-hmr-'));
  process.env.RNRUN_BUNDLE_CACHE_DIR = path.join(root, 'bundle-cache');
  dir = path.join(root, 'app');
  fs.cpSync(FIXTURE, dir, { recursive: true });
});

after(() => {
  delete process.env.RNRUN_BUNDLE_CACHE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

function nativeSession() {
  const { files } = scanProject(dir);
  return new BundlerSession(files, {
    packageServerUrl: 'http://127.0.0.1:0',
    env: {},
    platform: 'ios',
    assetPublicPath: '/__bm_assets',
    metroPrelude: PRELUDE,
    toolVersions: 'test',
  });
}

function edit(rel, content) {
  fs.writeFileSync(path.join(dir, rel), content);
  return [{ type: 'update', path: '/' + rel, content }];
}

function events(session) {
  const seen = [];
  session.onEvent((e) => seen.push(e.type));
  return seen;
}

test('a restart that serves the cached bundle keeps its identity, ids, and patches the first edit', async () => {
  const first = nativeSession();
  assert.equal(await first.build(), true);
  await first.applyChanges(edit('lib/greet.ts', 'export const greet = (n: string) => `hi, ${n}`;\n'));
  const ids = new Map(first.getModuleIds().entries());

  // The "wake": same files, so the build is served from the cache.
  const woken = nativeSession();
  const seen = events(woken);
  assert.equal(await woken.build(), true);
  assert.equal(woken.restoredFromCache, true);
  assert.equal(woken.epoch, first.epoch);
  assert.equal(woken.bundleVersion, first.bundleVersion);
  assert.equal(woken.bundleTag, first.bundleTag, 'a phone holding these bytes keeps its launch key');
  assert.equal(woken.versionForTag(first.bundleTag), first.bundleVersion);

  const servedVersion = woken.bundleVersion;
  await woken.applyChanges(edit('lib/greet.ts', 'export const greet = (n: string) => `hello again, ${n}`;\n'));
  assert.deepEqual(seen, ['hmr'], 'the first edit after a wake is a patch, not a reload');
  assert.ok(woken.catchUp(servedVersion), 'a device on the served bundle can be caught up');
  for (const [key, id] of woken.getModuleIds().entries()) {
    if (ids.has(key)) assert.equal(id, ids.get(key), `${key} keeps its id`);
  }
});

test('tags name one bundle: a new run never reuses an earlier run\'s tag for other bytes', async () => {
  const a = nativeSession();
  process.env.RNRUN_NO_BUNDLE_CACHE = '1';
  try {
    await a.build();
    const b = nativeSession();
    await b.build();
    assert.equal(a.bundleVersion, b.bundleVersion);
    assert.notEqual(a.bundleTag, b.bundleTag);
    assert.equal(b.versionForTag(a.bundleTag), null);
  } finally {
    delete process.env.RNRUN_NO_BUNDLE_CACHE;
  }
});

// ---------------------------------------------------------------------------
// The hub, with a device whose dev client registers in anonymous mode.
// ---------------------------------------------------------------------------

let dev, base, ctx, session;

async function startHub() {
  session = nativeSession();
  await session.build();
  const { files } = scanProject(dir);
  const web = new BundlerSession(files, {
    packageServerUrl: 'http://127.0.0.1:0',
    env: {},
    platform: 'web',
    assetPublicPath: '/__bm_assets',
  });
  ctx = {
    session: web,
    config: { app: { name: 'Plain App', slug: 'plain-app' }, env: {}, pkg: { dependencies: {} } },
    rootDir: dir,
    title: 'Plain App',
    port: 0,
    log: () => {},
    expoGoAnonymous: true,
    getPlatformSession: async () => session,
    peekPlatformSession: () => session,
  };
  dev = await startServer(ctx, '127.0.0.1');
  dev.hub.attachNativeSession(session);
  base = `http://127.0.0.1:${dev.port}`;
}

function ws(pathname) {
  const sock = new WebSocket(base.replace('http', 'ws') + pathname);
  const frames = [];
  sock.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  return new Promise((resolve, reject) => {
    sock.once('open', () => resolve({ sock, frames }));
    sock.once('error', reject);
  });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const res = await fetch(base + '/', { headers: { 'expo-platform': 'ios', accept: 'application/expo+json' } });
  const manifest = await res.json();
  assert.equal(manifest.extra.expoGo.developer, undefined, 'anonymous manifest');
  await fetch(manifest.launchAsset.url);
  return { url: manifest.launchAsset.url, tag: manifest.launchAsset.key.replace(/^bundle-/, '') };
}

test('hub: a current anonymous device learns its tag; a broadcast patch names its base', async (t) => {
  await startHub();
  t.after(() => dev.close());
  const { url, tag } = await launch();
  assert.equal(tag, session.bundleTag);

  const hot = await ws('/hot');
  hot.sock.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [url], rnrunBundle: tag }));
  await settle();
  const initial = hot.frames.find((f) => f.type === 'update');
  assert.equal(initial.body.rnrunBundle, tag);
  assert.deepEqual(initial.body.modified, []);

  await session.applyChanges(edit('lib/greet.ts', 'export const greet = (n: string) => `patched, ${n}`;\n'));
  await settle();
  const patch = hot.frames.filter((f) => f.type === 'update').at(-1);
  assert.equal(patch.body.isInitialUpdate, false);
  assert.equal(patch.body.rnrunBase, tag);
  assert.equal(patch.body.rnrunBundle, session.bundleTag);
  assert.ok(patch.body.modified.length > 0);
  hot.sock.close();
});

test('hub: a device that reconnects with the tag it was patched to gets no catch-up again', async (t) => {
  await startHub();
  t.after(() => dev.close());
  const { url } = await launch();
  await session.applyChanges(edit('lib/greet.ts', 'export const greet = (n: string) => `twice, ${n}`;\n'));

  // Its token was served the older bundle, but it reports the newer tag.
  const hot = await ws('/hot');
  hot.sock.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [url], rnrunBundle: session.bundleTag }));
  await settle();
  const initial = hot.frames.find((f) => f.type === 'update');
  assert.deepEqual(initial.body.modified, [], 'already current');
  hot.sock.close();
});

test('hub: an anonymous device that can\'t be patched is told it is stale, never reloaded', async (t) => {
  await startHub();
  t.after(() => dev.close());
  const { url } = await launch();
  const token = clientTokenFromUrl(url);

  const message = await ws('/message');
  const devClient = await ws(`/__rnrun?token=${token}&platform=ios&anonymous=1`);
  // Expo Go's own HMR client registers too (no tag), and the dev client
  // registers with a tag from a bundle this server never made.
  const expoGo = await ws('/hot');
  expoGo.sock.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [url] }));
  const hot = await ws('/hot');
  hot.sock.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [url], rnrunBundle: 'gone-1-abc' }));
  await settle(3500); // past the dev-client grace period

  // The token was served the current bundle, so the server falls back to it.
  assert.ok(!hot.frames.some((f) => f.type === 'rnrun-stale'));

  // A device whose token is unknown too: a bundle from before a restart.
  const hot2 = await ws('/hot');
  hot2.sock.send(JSON.stringify({
    type: 'register-entrypoints',
    entryPoints: [url.replace(/rnrunClient=[^&]+/, 'rnrunClient=unknown')],
    rnrunBundle: 'gone-1-abc',
  }));
  await settle();
  const stale = hot2.frames.find((f) => f.type === 'rnrun-stale');
  assert.ok(stale, 'told it is stale');
  assert.match(stale.reason, /previous dev server/);

  assert.deepEqual(devClient.frames.map((f) => f.type), ['hello']);
  assert.equal(message.frames.filter((f) => f.method === 'reload').length, 0, 'no reload broadcast');
  for (const s of [message, devClient, expoGo, hot, hot2]) s.sock.close();
});
