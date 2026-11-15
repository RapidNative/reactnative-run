// A native (ios/android) session whose first build failed must rebuild on the
// next bundle request once the cause is gone, instead of serving its stale
// error until a file changes or the process restarts. 2026-11-15: the package
// proxy's cert expired; after it was renewed, web recovered (ensureBuilt per
// request) but phones kept getting "TypeError: fetch failed".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanProject } from '../dist/project/scan.js';
import { BundlerSession } from '../dist/bundler/session.js';
import { startServer } from '../dist/server/server.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plain-app');
const SERVER = 'http://pkg.test';

let dir;
let dev;
let base;
let down = true;
let builds = 0;

// The package server: unreachable while `down`, then no combined bundle (so
// the bundler falls back to the single package fetch) and the one package.
const fakeFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (down) throw new TypeError('fetch failed');
  if (url.includes('/bundle-deps')) return new Response('no', { status: init?.method === 'POST' ? 500 : 404 });
  if (url.includes('/pkg/tiny-dep')) return new Response('module.exports = { hello: "from-tiny-dep" };', { status: 200 });
  return new Response('not found', { status: 404 });
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-native-retry-'));
  // A bundle cached on disk by an earlier run would be served instead of the
  // failing first build this test needs.
  process.env.RNRUN_BUNDLE_CACHE_DIR = path.join(dir, '.bundle-cache');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'plain-app', version: '1.0.0', dependencies: { 'tiny-dep': '1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'index.tsx'), 'import tiny from "tiny-dep";\n(globalThis as any).__TINY__ = tiny.hello;\n');

  const nativeSessions = new Map();
  const created = new Map(); // what start.ts's readyNative holds
  const ctx = {
    session: null,
    config: { app: { name: 'Plain App', slug: 'plain-app' }, env: {}, pkg: { dependencies: { 'tiny-dep': '1.0.0' } } },
    rootDir: dir,
    title: 'Plain App',
    port: 0,
    log: () => {},
    // Mirrors start.ts: a failed first build still resolves to its session.
    getPlatformSession: async (platform) => {
      if (platform !== 'ios' && platform !== 'android') return null;
      if (!nativeSessions.has(platform)) {
        const { files } = scanProject(dir);
        const native = new BundlerSession(files, {
          packageServerUrl: SERVER,
          env: {},
          platform,
          assetPublicPath: '/__bm_assets',
          fetch: fakeFetch,
        });
        const realBuild = native.build.bind(native);
        native.build = () => {
          builds++;
          return realBuild();
        };
        created.set(platform, native);
        nativeSessions.set(platform, native.build().then(() => native));
      }
      return nativeSessions.get(platform);
    },
    peekPlatformSession: (platform) => created.get(platform) ?? null,
  };
  ctx.session = new BundlerSession(scanProject(dir).files, { packageServerUrl: SERVER, env: {}, platform: 'web', assetPublicPath: '/__bm_assets', fetch: fakeFetch });
  dev = await startServer(ctx, '127.0.0.1');
  base = `http://127.0.0.1:${dev.port}`;
});

after(async () => {
  await dev?.close();
  delete process.env.RNRUN_BUNDLE_CACHE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a native build that failed is retried on the next request once the package server is back', async () => {
  const failed = await fetch(base + '/index.bundle?platform=ios');
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).message, /fetch failed/);
  assert.equal(builds, 1);

  down = false;
  const ok = await fetch(base + '/index.bundle?platform=ios');
  const body = await ok.text();
  assert.equal(ok.status, 200, body.slice(0, 300));
  assert.match(body, /from-tiny-dep/);
  assert.equal(builds, 2);

  // Built now: later requests are served, not rebuilt.
  const again = await fetch(base + '/index.bundle?platform=ios');
  assert.equal(again.status, 200);
  await again.text();
  assert.equal(builds, 2);
});
