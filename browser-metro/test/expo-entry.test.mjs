// Tests for the expo entry-synthesis module (src/expo/entry.ts), lifted from
// the example worker so Node consumers (the rnrun CLI) can reuse it.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isApiRouteFile,
  filePathToApiRoute,
  buildApiRoutesEntry,
  buildExpoRouteContext,
  buildExpoRouterEntry,
  ensureEntryFile,
  applyRouteStructureChanges,
} from '../dist/expo/entry.js';
import { platformSourceExts } from '../dist/resolver.js';
import { VirtualFS } from '../dist/fs.js';

function makeRouterProject(extraFiles = {}) {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', main: 'expo-router/entry', dependencies: {} }));
  fs.write('/app/_layout.tsx', 'export default function L() { return null; }\n');
  fs.write('/app/index.tsx', 'export default function Home() { return null; }\n');
  for (const [path, content] of Object.entries(extraFiles)) fs.write(path, content);
  return fs;
}

test('isApiRouteFile matches +api files only', () => {
  assert.equal(isApiRouteFile('/app/api/hello+api.ts'), true);
  assert.equal(isApiRouteFile('/app/api/hello+api.jsx'), true);
  assert.equal(isApiRouteFile('/app/api/hello.ts'), false);
  assert.equal(isApiRouteFile('/app/index.tsx'), false);
});

test('filePathToApiRoute maps files to URL paths', () => {
  assert.equal(filePathToApiRoute('/app/api/hello+api.ts'), '/api/hello');
  assert.equal(filePathToApiRoute('/app/api/users/[id]+api.ts'), '/api/users/[id]');
  assert.equal(filePathToApiRoute('/app/api/index+api.ts'), '/api');
  assert.equal(filePathToApiRoute('/app/index+api.ts'), '/');
});

test('buildExpoRouteContext includes routes, excludes API files, wraps loads in try/catch', () => {
  const fs = makeRouterProject({
    '/app/api/hello+api.ts': 'export function GET() {}\n',
    '/app/notes.txt': 'not a route',
  });
  const ctx = buildExpoRouteContext(fs);
  assert.match(ctx, /modules\["\.\/index\.tsx"\] = require\("\.\/app\/index"\)/);
  assert.match(ctx, /modules\["\.\/_layout\.tsx"\] = require\("\.\/app\/_layout"\)/);
  assert.doesNotMatch(ctx, /hello\+api/);
  assert.doesNotMatch(ctx, /notes\.txt/);
  // Per-route try/catch: a broken route must throw on navigation, not at require time.
  assert.match(ctx, /try \{ modules\["\.\/index\.tsx"\]/);
  assert.match(ctx, /moduleErrors/);
});

test('route context module executes: keys() lists routes, broken route throws on access', () => {
  const fs = makeRouterProject();
  const src = buildExpoRouteContext(fs);
  const requires = {
    './app/_layout': { default: 'layout' },
    './app/index': null, // simulate a route whose require throws
  };
  const mod = { exports: {} };
  const requireFn = (id) => {
    if (requires[id] === null) throw new Error('boom');
    return requires[id];
  };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, requireFn);
  const ctx = mod.exports;
  assert.deepEqual(ctx.keys().sort(), ['./_layout.tsx', './index.tsx']);
  assert.equal(ctx('./_layout.tsx').default, 'layout');
  assert.throws(() => ctx('./index.tsx'), /boom/);
});

test('ensureEntryFile synthesizes the split entry for expo-router projects', () => {
  const fs = makeRouterProject();
  const entry = ensureEntryFile(fs);
  assert.equal(entry, '/index.tsx');
  assert.ok(fs.exists('/__expo_ctx.js'));
  const entrySrc = fs.read('/index.tsx');
  assert.match(entrySrc, /registerRootComponent/);
  assert.match(entrySrc, /require\("\.\/__expo_ctx"\)/);
  assert.match(entrySrc, /globalThis\.__EXPO_ROOT_REGISTERED/);
});

test('ensureEntryFile prefers an existing entry over synthesis', () => {
  const fs = makeRouterProject({ '/index.js': 'console.log("real entry");\n' });
  assert.equal(ensureEntryFile(fs), '/index.js');
  assert.equal(fs.exists('/__expo_ctx.js'), false);
});

test('ensureEntryFile returns null for non-router project with no entry', () => {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  assert.equal(ensureEntryFile(fs), null);
});

test('applyRouteStructureChanges regenerates ctx on route create/delete only', () => {
  const fs = makeRouterProject();
  ensureEntryFile(fs);
  const before = fs.read('/__expo_ctx.js');

  // A content update to an existing route must NOT regenerate the context.
  assert.equal(
    applyRouteStructureChanges(fs, [{ path: '/app/index.tsx', type: 'update', content: 'x' }]),
    null,
  );

  // Creating a new route regenerates and returns the ctx change.
  fs.write('/app/two.tsx', 'export default function Two() { return null; }\n');
  const change = applyRouteStructureChanges(fs, [
    { path: '/app/two.tsx', type: 'create', content: '' },
  ]);
  assert.ok(change);
  assert.equal(change.path, '/__expo_ctx.js');
  assert.equal(change.type, 'update');
  assert.match(change.content, /two\.tsx/);
  assert.notEqual(fs.read('/__expo_ctx.js'), before);

  // API file creation must not regenerate.
  fs.write('/app/api/x+api.ts', 'export function GET() {}\n');
  assert.equal(
    applyRouteStructureChanges(fs, [{ path: '/app/api/x+api.ts', type: 'create', content: '' }]),
    null,
  );
});

test('applyRouteStructureChanges is a no-op for non-router projects', () => {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', main: 'index.js', dependencies: {} }));
  fs.write('/app/new.tsx', 'export default 1;\n');
  assert.equal(
    applyRouteStructureChanges(fs, [{ path: '/app/new.tsx', type: 'create', content: '' }]),
    null,
  );
});

test('buildApiRoutesEntry returns null without +api files, maps routes with them', () => {
  const fs = makeRouterProject();
  assert.equal(buildApiRoutesEntry(fs), null);

  fs.write('/app/api/hello+api.ts', 'export function GET() {}\n');
  fs.write('/app/api/users/[id]+api.ts', 'export function GET() {}\n');
  const src = buildApiRoutesEntry(fs);
  assert.match(src, /"\/api\/hello": require\("\.\/app\/api\/hello\+api"\)/);
  assert.match(src, /"\/api\/users\/\[id\]"/);
  assert.match(src, /function match\(/);
});

test('buildExpoRouterEntry references ExpoRoot and the ctx module', () => {
  const src = buildExpoRouterEntry();
  assert.match(src, /ExpoRoot/);
  assert.match(src, /module\.hot|require\("\.\/__expo_ctx"\)/);
});

test('platformSourceExts: web default matches the historical example order', () => {
  assert.deepEqual(platformSourceExts(), ['web.ts', 'web.tsx', 'web.js', 'web.jsx', 'ts', 'tsx', 'js', 'jsx']);
  assert.deepEqual(platformSourceExts('web'), platformSourceExts());
});

test('platformSourceExts: native platforms resolve platform, then native, then bare', () => {
  assert.deepEqual(platformSourceExts('ios'), [
    'ios.ts', 'ios.tsx', 'ios.js', 'ios.jsx',
    'native.ts', 'native.tsx', 'native.js', 'native.jsx',
    'ts', 'tsx', 'js', 'jsx',
  ]);
  assert.equal(platformSourceExts('android')[0], 'android.ts');
});
