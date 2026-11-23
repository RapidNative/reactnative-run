// Regression tests: a source file nothing imports must not enter the bundle
// through rebuild(), while new screens and new imports still do.
//
// Rip Yours (2026-11-18): the coding agent wrote mobile/scripts/check-held-card-images.mjs,
// a Node script (`import { readFileSync } from "node:fs"`) that nothing in the app imports.
// rebuild() pushed every created source file through processFile, so the preview failed with
//   Unable to resolve "node:fs" from "scripts/check-held-card-images.mjs"
// Metro only walks from the entry, so the same file is a no-op there.
//
// Run: npm test  (builds with tsc, then `node --test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalBundler } from '../dist/incremental-bundler.js';
import { VirtualFS } from '../dist/fs.js';
import { typescriptTransformer } from '../dist/transforms/typescript.js';

const CONFIG = {
  resolver: { sourceExts: ['js', 'ts', 'tsx', 'jsx', 'mjs'] },
  transformer: typescriptTransformer,
  server: { packageServerUrl: 'http://127.0.0.1:0' },
};

const NODE_SCRIPT = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').length);
`;

function makeBundler() {
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', dependencies: {} }));
  fs.write('/app/index.tsx', `export default function Home() { return 'home'; }\n`);
  return { fs, bundler: new IncrementalBundler(fs, CONFIG) };
}

test('a Node script nothing imports does not fail the rebuild or enter the bundle', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  fs.write('/scripts/check-held-card-images.mjs', NODE_SCRIPT);
  const created = await bundler.rebuild([{ type: 'create', path: '/scripts/check-held-card-images.mjs' }]);
  assert.ok(created, 'rebuild completed');
  assert.ok(!created.bundle.includes('check-held-card-images'), 'the script is not in the bundle');

  // Saved again (an update of a file that was never a module): still left out.
  fs.write('/scripts/check-held-card-images.mjs', NODE_SCRIPT + '// v2\n');
  const updated = await bundler.rebuild([{ type: 'update', path: '/scripts/check-held-card-images.mjs' }]);
  assert.ok(!updated.bundle.includes('check-held-card-images'));
});

test('a new file is bundled once something imports it, in the same rebuild', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');

  fs.write('/src/greeting.ts', `export const greeting = 'hello from greeting';\n`);
  fs.write('/app/index.tsx', `import { greeting } from '../src/greeting';\nexport default function Home() { return greeting; }\n`);
  const result = await bundler.rebuild([
    { type: 'create', path: '/src/greeting.ts' },
    { type: 'update', path: '/app/index.tsx' },
  ]);
  assert.ok(result.bundle.includes('hello from greeting'), 'the imported file is bundled');
});

test('a file written after the import that wanted it replaces the stub', async () => {
  const { fs, bundler } = makeBundler();
  fs.write('/app/index.tsx', `import { later } from '../src/later';\nexport default function Home() { return later; }\n`);
  await bundler.build('/app/index.tsx');

  fs.write('/src/later.ts', `export const later = 'arrived later';\n`);
  const result = await bundler.rebuild([{ type: 'create', path: '/src/later.ts' }]);
  assert.ok(result.bundle.includes('arrived later'), 'the stub was replaced by the real module');
});

test('a changed file that is already a module is still rebuilt', async () => {
  const { fs, bundler } = makeBundler();
  await bundler.build('/app/index.tsx');
  fs.write('/app/index.tsx', `export default function Home() { return 'home v2'; }\n`);
  const result = await bundler.rebuild([{ type: 'update', path: '/app/index.tsx' }]);
  assert.ok(result.bundle.includes('home v2'));
});

test('a new expo-router screen still reaches the bundle, through the regenerated route context', async () => {
  const { buildExpoRouteContext, applyRouteStructureChanges } = await import('../dist/expo/entry.js');
  const fs = new VirtualFS({});
  fs.write('/package.json', JSON.stringify({ name: 'app', main: 'expo-router/entry', dependencies: {} }));
  fs.write('/app/index.tsx', `export default function Home() { return 'home'; }\n`);
  fs.write('/__expo_ctx.js', buildExpoRouteContext(fs));
  const bundler = new IncrementalBundler(fs, CONFIG);
  await bundler.build('/__expo_ctx.js');

  fs.write('/app/about.tsx', `export default function About() { return 'about screen'; }\n`);
  fs.write('/scripts/seed.mjs', NODE_SCRIPT);
  const changes = [
    { type: 'create', path: '/app/about.tsx' },
    { type: 'create', path: '/scripts/seed.mjs' },
  ];
  const ctx = applyRouteStructureChanges(fs, changes);
  assert.ok(ctx, 'the route context was regenerated');
  const result = await bundler.rebuild([...changes, { type: ctx.type, path: ctx.path }]);
  assert.ok(result.bundle.includes('about screen'), 'the new screen is bundled');
  assert.ok(!result.bundle.includes('node:fs'), 'the Node script is not');
});
