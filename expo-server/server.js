const express = require('express');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 8088;

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();

// ============================================
// The Hello World React Native bundle
// ============================================
function generateBundle(platform) {
  // Expo Go already has React and React Native loaded.
  // The global `require` in Expo Go's runtime resolves to its internal module system.
  // We just need to use that global require, not Metro's __d/__r system.
  //
  // However, Expo Go expects the Metro module system to exist (it calls __r to start).
  // So we set up __d and __r but have our entry module use the global require().

  return `
var __BUNDLE_START_TIME__=this.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=true,process={env:{NODE_ENV:"development"}},__METRO_GLOBAL_PREFIX__='';

// Minimal Metro module system (required by Expo Go runtime)
(function (global) {
  'use strict';
  var modules = Object.create(null);

  function define(factory, moduleId, dependencyMap) {
    modules[moduleId] = {
      factory: factory,
      dependencyMap: dependencyMap || [],
      isInitialized: false,
      publicModule: { exports: {} }
    };
  }

  function metroRequire(moduleId) {
    var module = modules[moduleId];
    if (!module) {
      // Fall back to global require (Expo Go's internal require)
      if (typeof global.require === 'function') {
        return global.require(moduleId);
      }
      throw new Error('Module not found: ' + moduleId);
    }
    if (module.isInitialized) {
      return module.publicModule.exports;
    }
    module.isInitialized = true;
    var _require = function(id) {
      // If it's a dependency index, resolve from dependency map
      if (typeof id === 'number' && module.dependencyMap[id] !== undefined) {
        return metroRequire(module.dependencyMap[id]);
      }
      return metroRequire(id);
    };
    module.factory(global, _require, module, module.publicModule.exports, module.dependencyMap);
    return module.publicModule.exports;
  }

  global.__d = define;
  global.__r = metroRequire;
  global.__c = Object.create(null);
  global.__registerSegment = function() {};
})(typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : this);

// Module 0: App entry point
__d(function(global, require, module, exports, _dependencyMap) {
  'use strict';

  // Use the global require which resolves through Expo Go's module system
  var _interopDefault = function(m) { return m && m.__esModule ? m.default : m; };

  var React = _interopDefault(require('react'));
  var RN = require('react-native');

  var App = function App() {
    return React.createElement(
      RN.View,
      { style: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1c1917' } },
      React.createElement(
        RN.Text,
        { style: { fontSize: 36, fontWeight: '800', color: '#d97706', marginBottom: 16 } },
        'Hello World!'
      ),
      React.createElement(
        RN.Text,
        { style: { fontSize: 18, color: '#fafaf9', marginBottom: 8 } },
        'Served from fake-expo-dev-server'
      ),
      React.createElement(
        RN.Text,
        { style: { fontSize: 14, color: '#78716c' } },
        'Platform: ${platform}'
      )
    );
  };

  // Register the component with 'main' key
  RN.AppRegistry.registerComponent('main', function() { return App; });

  // Also run the application immediately (Expo Go might not auto-run 'main')
  if (typeof RN.AppRegistry.runApplication === 'function') {
    try {
      RN.AppRegistry.runApplication('main', {
        initialProps: {},
        rootTag: 1
      });
    } catch(e) {
      // rootTag might be wrong, that's ok - Expo Go will run it
      console.log('runApplication error (expected):', e.message);
    }
  }
}, 0, []);

// Start
__r(0);
`;
}

// ============================================
// Manifest endpoint - Expo Go requests this first
// ============================================
function handleManifest(req, res) {
  const platform = req.headers['expo-platform'] || req.query.platform || 'ios';
  const host = req.headers.host || `${LOCAL_IP}:${PORT}`;

  console.log(`[manifest] platform=${platform}, host=${host}`);

  const manifest = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion: '1.0.0',
    launchAsset: {
      key: 'bundle',
      contentType: 'application/javascript',
      url: `http://${host}/index.bundle?platform=${platform}&dev=true&hot=false&lazy=true`,
    },
    assets: [],
    metadata: {},
    extra: {
      eas: {},
      expoClient: {
        name: 'Fake Expo Server',
        slug: 'fake-expo-server',
        version: '1.0.0',
        orientation: 'portrait',
        sdkVersion: '54.0.0',
        platforms: ['ios', 'android'],
        ios: { supportsTablet: true, bundleIdentifier: 'com.fakeexpo.test' },
        android: { package: 'com.fakeexpo.test' },
        hostUri: host,
        scheme: 'fakeexpo',
      },
      expoGo: {
        debuggerHost: host,
        developer: {
          tool: 'expo-cli',
          projectRoot: __dirname,
        },
        packagerOpts: {
          dev: true,
        },
        mainModuleName: 'index',
      },
      scopeKey: `@anonymous/fake-expo-server-${crypto.randomUUID().slice(0, 8)}`,
    },
  };

  // Try both formats based on what Expo Go accepts
  const accept = req.headers.accept || '';

  if (accept.includes('multipart/mixed')) {
    const manifestJson = JSON.stringify(manifest);
    const boundary = 'formdata-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="manifest"\r\n` +
      `Content-Type: application/json\r\n` +
      `\r\n` +
      manifestJson + `\r\n` +
      `--${boundary}--\r\n`;

    res.writeHead(200, {
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
      'expo-protocol-version': '0',
      'expo-sfv-version': '0',
      'cache-control': 'private, max-age=0',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } else {
    res.set({
      'Content-Type': 'application/json',
      'expo-protocol-version': '0',
      'expo-sfv-version': '0',
      'cache-control': 'private, max-age=0',
    });
    res.json(manifest);
  }
}

// ============================================
// Routes
// ============================================

// Manifest - multiple paths that Expo Go might request
app.get('/', handleManifest);
app.get('/manifest', handleManifest);
app.get('/index.exp', handleManifest);

// Bundle endpoint - match any path ending in .bundle
app.get(/\.bundle$/, async (req, res) => {
  const platform = req.query.platform || 'ios';
  console.log(`[bundle] path=${req.path}, platform=${platform}`);

  // FILE MODE: Serve a bundle from a local file
  const bundleFile = process.env.BUNDLE_FILE;
  if (bundleFile) {
    const filePath = path.resolve(bundleFile);
    if (fs.existsSync(filePath)) {
      const body = fs.readFileSync(filePath, 'utf-8');
      console.log(`[bundle] serving from file: ${filePath} (${(body.length / 1024).toFixed(0)}KB)`);
      res.set({ 'Content-Type': 'application/javascript' });
      res.send(body);
      return;
    } else {
      console.log(`[bundle] file not found: ${filePath}`);
    }
  }

  // PROXY MODE: Forward to real Metro if METRO_PROXY is set
  const metroProxy = process.env.METRO_PROXY;
  if (metroProxy) {
    console.log(`[bundle] proxying to ${metroProxy}...`);
    try {
      const url = `${metroProxy}/node_modules/expo-router/entry.bundle?platform=${platform}&dev=true&hot=false&lazy=true`;
      const proxyRes = await fetch(url);
      const body = await proxyRes.text();
      console.log(`[bundle] proxied ${(body.length / 1024 / 1024).toFixed(1)}MB`);
      res.set({ 'Content-Type': 'application/javascript' });
      res.send(body);
      return;
    } catch (e) {
      console.log(`[bundle] proxy failed: ${e.message}, falling back to generated bundle`);
    }
  }

  // STANDALONE MODE: Serve our minimal bundle
  const bundle = generateBundle(platform);
  res.set({
    'Content-Type': 'application/javascript',
    'X-Metro-Files-Changed-Count': '0',
  });
  res.send(bundle);
});

// Status endpoint
app.get('/status', (req, res) => {
  res.send('packager-status:running');
});

// Source map (stub)
app.get(/\.map$/, (req, res) => {
  res.json({
    version: 3,
    sources: ['index.js'],
    mappings: '',
    names: [],
  });
});

// Assets (stub)
app.get(/^\/assets\//, (req, res) => {
  res.status(404).send('No assets');
});

// Symbolicate (stub)
app.post('/symbolicate', (req, res) => {
  res.json({ codeFrames: [] });
});

// Catch-all logging
app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url} (headers: ${JSON.stringify(req.headers['expo-platform'] || 'none')})`);
  res.status(404).send('Not found');
});

// ============================================
// Start server
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('===========================================');
  console.log('  Fake Expo Dev Server');
  console.log('===========================================');
  console.log('');
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${LOCAL_IP}:${PORT}`);
  console.log(`  Expo Go:  exp://${LOCAL_IP}:${PORT}`);
  console.log('');
  console.log('  Open Expo Go on your phone and enter:');
  console.log(`  exp://${LOCAL_IP}:${PORT}`);
  console.log('');
  console.log('  Or on iOS Simulator:');
  console.log(`  xcrun simctl openurl booted "exp://${LOCAL_IP}:${PORT}"`);
  console.log('');
  console.log('===========================================');
  console.log('');
});
