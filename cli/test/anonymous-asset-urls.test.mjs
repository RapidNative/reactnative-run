// In anonymous mode (no expoGo.developer, iOS hosted previews) expo-asset can't map a
// dev-server asset to this server and falls back to Expo's CDN, so every require()d image was
// blank on iOS. The dev client makes asset locations absolute on this server's origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_DEV_CLIENT_SOURCE } from '../dist/bundler/native-dev-client.js';

function run({ developer }) {
  const g = globalThis;
  class FakeSocket {
    constructor(url) {
      this.url = url;
    }
    send() {}
    close() {}
  }
  const registered = [];
  const registry = {
    registerAsset(asset) {
      registered.push(asset);
      return registered.length;
    },
    getAssetByID: (id) => registered[id - 1],
  };
  const expoGo = developer ? { debuggerHost: 'abc.rapidnative.dev', developer: { tool: 'rnrun' } } : { debuggerHost: 'abc.rapidnative.dev' };
  const scriptURL = 'https://abc.rapidnative.dev/index.bundle?platform=ios&dev=true&rnrunClient=tok';
  g.WebSocket = FakeSocket;
  g.expo = { modules: { ExponentConstants: { manifest: { launchAsset: { key: 'k', url: scriptURL }, extra: { expoGo } } } } };
  const RN = {
    AssetRegistry: registry,
    Platform: { OS: 'ios' },
    NativeModules: { SourceCode: { getConstants: () => ({ scriptURL }) } },
    DevSettings: { reload() {} },
    Alert: { alert() {} },
  };
  try {
    new Function('require', NATIVE_DEV_CLIENT_SOURCE)((m) => (m === 'react-native' ? RN : null));
    // An asset module, as browser-metro emits it, after the dev client has run.
    registry.registerAsset({ __packager_asset: true, name: 'logo', type: 'png', hash: 'h', httpServerLocation: '/assets/assets', scales: [1] });
    registry.registerAsset({ __packager_asset: true, name: 'cdn', type: 'png', hash: 'h2', httpServerLocation: 'https://cdn.example/x', scales: [1] });
    return registered;
  } finally {
    for (const k of ['__rnrunDevClient', 'expo', 'WebSocket']) delete g[k];
  }
}

test('anonymous mode: asset locations become absolute on the preview origin', () => {
  const [logo, cdn] = run({ developer: false });
  assert.equal(logo.httpServerLocation, 'https://abc.rapidnative.dev/assets/assets');
  assert.equal(logo.name, 'logo');
  assert.equal(cdn.httpServerLocation, 'https://cdn.example/x', 'an absolute location is left alone');
});

test('dev-server mode (Android, local): asset locations stay relative', () => {
  const [logo] = run({ developer: true });
  assert.equal(logo.httpServerLocation, '/assets/assets');
});
