// The anonymous-mode dev client against the REAL metro-runtime prelude (the
// file the device runs, cached by the package server). Bôtel (2026-11-04):
// right after the agent's edits an iPhone logged "rnrun: could not apply an
// update, reloading. [Refresh] Expected to find the updated module." 62 times
// in a minute. A catch-up patch carries a module the phone doesn't have yet
// (the agent added it after the phone's bundle) as "modified", because the
// server already knows it, and its dependency is hot-swapped first: metro's
// walk up the inverse dependencies reaches the parent the phone doesn't have
// and throws. The client then reloaded, which in anonymous mode replays the
// bundle the phone first downloaded, which gets the same catch-up patch.
//
// Skips when the prelude isn't cached (reactnative-esm/cache/prelude-*.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_DEV_CLIENT_SOURCE } from '../dist/bundler/native-dev-client.js';
import { emitMetroModule, buildMetroHmrBody } from 'browser-metro';
import { ModuleIdRegistry } from '../../browser-metro/dist/module-ids.js';

const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../reactnative-esm/cache');
const preludeFile = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).find((f) => f.startsWith('prelude-')) : undefined;

/** Boot a phone: the prelude, the original bundle's modules, the dev client, the entry. */
function bootPhone({ registry, original, entry }) {
  const prelude = fs.readFileSync(path.join(cacheDir, preludeFile), 'utf8');
  const sockets = [];
  const calls = { updatesReload: 0, devReload: 0, alerts: [], errors: [] };
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      sockets.push(this);
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close() {
      this.closed = true;
    }
  }
  const g = globalThis;
  g.global = g;
  g.__DEV__ = true;
  g.__METRO_GLOBAL_PREFIX__ = '';
  g.__ReactRefresh = {
    isLikelyComponentType: (f) => typeof f === 'function' && /^[A-Z]/.test(f.name || ''),
    register() {},
    performReactRefresh() {},
    performFullRefresh() {
      calls.fullRefresh = (calls.fullRefresh ?? 0) + 1;
    },
    getFamilyByType() {
      return undefined;
    },
  };
  g.WebSocket = FakeSocket;
  g.expo = {
    modules: {
      ExponentConstants: {
        manifest: { launchAsset: { key: 'bundle-tag-v0', url: 'http://dev.test/index.bundle?rnrunClient=tok' }, extra: { expoGo: {} } },
      },
      ExpoUpdates: {
        reload() {
          calls.updatesReload++;
          return { then() {} };
        },
      },
    },
  };
  const RN = {
    Platform: { OS: 'ios' },
    NativeModules: { SourceCode: { getConstants: () => ({ scriptURL: 'http://dev.test/index.bundle?rnrunClient=tok' }) } },
    DevSettings: { reload: () => calls.devReload++ },
    Alert: { alert: (title, msg) => calls.alerts.push(`${title}: ${msg}`) },
  };
  const origError = console.error;
  console.error = (...a) => calls.errors.push(a.join(' '));
  try {
    new Function(`${prelude}\n${original.join('\n')}`)();
    new Function('require', NATIVE_DEV_CLIENT_SOURCE)((m) => (m === 'react-native' ? RN : null));
    g.__r(registry.idFor(entry));
    for (const s of sockets) s.onopen?.();
  } finally {
    console.error = origError;
  }
  const hot = sockets.find((s) => s.url.includes('/hot'));
  return {
    calls,
    hot,
    /** The server's frames on /hot, as the client receives them. */
    receive(frame) {
      console.error = (...a) => calls.errors.push(a.join(' '));
      try {
        hot.onmessage({ data: JSON.stringify(frame) });
      } finally {
        console.error = origError;
      }
    },
    cleanup() {
      for (const k of ['__r', '__d', '__c', '__registerSegment', '__ReactRefresh', '__rnrunDevClient', 'expo', 'WebSocket', '__DEV__', '__METRO_GLOBAL_PREFIX__', '__THEME', '__SPLASH'])
        delete g[k];
    },
  };
}

test('a catch-up patch carrying a module the phone never had neither throws nor loops', (t) => {
  if (!preludeFile) {
    t.skip('no cached prelude (start reactnative-esm and fetch /prelude/<rnVersion> once)');
    return;
  }
  // The phone's bundle (v0): the entry renders Home, Home reads the theme.
  const registry = new ModuleIdRegistry();
  const original = [
    emitMetroModule('var H = require("/app/home.tsx").default; globalThis.__HOME = H;', '/index.tsx', registry).text,
    emitMetroModule('var t = require("/lib/theme.ts"); function Home() { return t.color; } exports.__esModule = true; exports.default = Home;', '/app/home.tsx', registry).text,
    emitMetroModule('exports.color = "yellow"; globalThis.__THEME = "v0";', '/lib/theme.ts', registry).text,
  ];
  const phone = bootPhone({ registry, original, entry: '/index.tsx' });
  t.after(() => phone.cleanup());
  assert.deepEqual(phone.hot.sent[0], { type: 'register-entrypoints', entryPoints: ['http://dev.test/index.bundle?rnrunClient=tok'], rnrunBundle: 'tag-v0' });

  // Meanwhile the agent added a splash screen that reads the theme (the server
  // registered it then), and changed the theme. The catch-up merges both.
  registry.idFor('/app/splash.tsx');
  const body = buildMetroHmrBody(
    {
      updatedModules: {
        '/lib/theme.ts': 'exports.color = "gold"; globalThis.__THEME = "v2";',
        '/app/splash.tsx': 'var t = require("/lib/theme.ts"); function Splash() { return t.color; } exports.__esModule = true; exports.default = Splash; globalThis.__SPLASH = Splash;',
        '/index.tsx': 'require("/app/splash.tsx"); var H = require("/app/home.tsx").default; globalThis.__HOME = H;',
      },
      removedModules: [],
      reverseDepsMap: {
        '/lib/theme.ts': ['/app/home.tsx', '/app/splash.tsx'],
        '/app/splash.tsx': ['/index.tsx'],
        '/app/home.tsx': ['/index.tsx'],
        '/index.tsx': [],
      },
    },
    registry,
    'rev-init-1'
  );
  // What the phone gets: the splash screen is "modified", not "added".
  assert.ok(body.modified.some((m) => m.sourceURL === '/app/splash.tsx'));

  phone.receive({ type: 'update', body: { ...body, isInitialUpdate: true, rnrunBundle: 'tag-v2', rnrunBase: 'tag-v0' } });

  // No "[Refresh] Expected to find the updated module" any more. The theme has no Refresh boundary
  // above it here (its new parent hasn't run, the entry isn't a component), so metro-runtime asks
  // for a full refresh; in anonymous mode that would replay this bundle and patch, so the client
  // asks the user to reopen instead. Never a reload.
  assert.deepEqual(phone.calls.errors, [], 'no error while applying');
  assert.equal(phone.calls.updatesReload + phone.calls.devReload + (phone.calls.fullRefresh ?? 0), 0, 'no reload, no full refresh');
  assert.equal(phone.calls.alerts.length, 1);
  assert.match(phone.calls.alerts[0], /open it again/);
});

test('a catch-up whose new module is off the refresh path applies in place', (t) => {
  if (!preludeFile) {
    t.skip('no cached prelude');
    return;
  }
  const registry = new ModuleIdRegistry();
  const original = [
    emitMetroModule('var H = require("/app/home.tsx").default; globalThis.__HOME = H;', '/index.tsx', registry).text,
    emitMetroModule('var t = require("/lib/theme.ts"); function Home() { return t.color; } exports.__esModule = true; exports.default = Home;', '/app/home.tsx', registry).text,
    emitMetroModule('exports.color = "yellow";', '/lib/theme.ts', registry).text,
  ];
  const phone = bootPhone({ registry, original, entry: '/index.tsx' });
  t.after(() => phone.cleanup());
  // The agent added a helper Home now uses (the server registered it then) and changed Home.
  registry.idFor('/lib/format.ts');
  const body = buildMetroHmrBody(
    {
      updatedModules: {
        '/lib/format.ts': 'exports.up = function (s) { return String(s).toUpperCase(); };',
        '/app/home.tsx': 'var t = require("/lib/theme.ts"); var f = require("/lib/format.ts"); function Home() { return f.up(t.color); } exports.__esModule = true; exports.default = Home;',
      },
      removedModules: [],
      reverseDepsMap: { '/lib/format.ts': ['/app/home.tsx'], '/app/home.tsx': ['/index.tsx'], '/index.tsx': [] },
    },
    registry,
    'rev-init-1'
  );
  assert.ok(body.modified.some((m) => m.sourceURL === '/lib/format.ts'), 'the helper arrives as "modified"');
  phone.receive({ type: 'update', body: { ...body, isInitialUpdate: true, rnrunBundle: 'tag-v1', rnrunBase: 'tag-v0' } });
  assert.deepEqual(phone.calls.errors, []);
  assert.deepEqual(phone.calls.alerts, []);
  assert.equal(phone.calls.updatesReload + phone.calls.devReload, 0);
  assert.equal(globalThis.__r(registry.idFor('/app/home.tsx')).default(), 'YELLOW');
});

test('a patch that still fails on arrival asks to reopen instead of reloading into the same patch', (t) => {
  if (!preludeFile) {
    t.skip('no cached prelude');
    return;
  }
  const registry = new ModuleIdRegistry();
  const original = [emitMetroModule('globalThis.__THEME = "v0";', '/index.tsx', registry).text];
  const phone = bootPhone({ registry, original, entry: '/index.tsx' });
  t.after(() => phone.cleanup());

  // A catch-up whose module throws while it is evaluated.
  const broken = { module: [registry.idFor('/index.tsx'), 'throw new Error("boom");'], sourceMappingURL: null, sourceURL: '/index.tsx' };
  phone.receive({
    type: 'update',
    body: { revisionId: 'rev-init-1', isInitialUpdate: true, added: [], modified: [broken], deleted: [], rnrunBundle: 'tag-v1', rnrunBase: 'tag-v0' },
  });
  assert.equal(phone.calls.updatesReload + phone.calls.devReload, 0, 'a reload would replay the same bundle and get the same patch');
  assert.equal(phone.calls.alerts.length, 1);
  assert.match(phone.calls.alerts[0], /open it again/);
  assert.match(phone.calls.errors.join('\n'), /could not apply an update/);
});
