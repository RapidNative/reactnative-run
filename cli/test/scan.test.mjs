import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanProject, shouldSkip, vfsToDisk, diskToVfs } from '../dist/project/scan.js';
import { isAssetPath, mimeFor } from '../dist/project/assets.js';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnrun-scan-'));
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/somepkg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ios'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","dependencies":{}}');
  fs.writeFileSync(path.join(dir, 'app/index.tsx'), 'export default 1;');
  fs.writeFileSync(path.join(dir, 'node_modules/somepkg/index.js'), 'ignored');
  fs.writeFileSync(path.join(dir, 'ios/Podfile'), 'ignored');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'ignored');
  fs.writeFileSync(path.join(dir, 'assets/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

test('scanProject picks up source, skips node_modules/ios/.DS_Store, externalizes assets', () => {
  const dir = makeTempProject();
  const { files } = scanProject(dir);
  assert.ok(files['/package.json']);
  assert.ok(files['/app/index.tsx']);
  assert.equal(files['/node_modules/somepkg/index.js'], undefined);
  assert.equal(files['/ios/Podfile'], undefined);
  assert.equal(files['/.DS_Store'], undefined);
  // Assets are marked external with EMPTY content -- bytes never enter memory.
  assert.deepEqual(files['/assets/icon.png'], { content: '', isExternal: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanProject skips oversized text files with a report', () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, 'huge.ts'), 'x'.repeat(3 * 1024 * 1024));
  const { files, skippedLarge } = scanProject(dir);
  assert.equal(files['/huge.ts'], undefined);
  assert.deepEqual(skippedLarge, ['/huge.ts']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shouldSkip handles nested skip dirs anywhere in the path', () => {
  assert.equal(shouldSkip('/app/index.tsx'), false);
  assert.equal(shouldSkip('/packages/a/node_modules/x.js'), true);
  assert.equal(shouldSkip('/android/build.gradle'), true);
  assert.equal(shouldSkip('/.git/HEAD'), true);
  // "android" as a file segment prefix must NOT match
  assert.equal(shouldSkip('/androidish/file.ts'), false);
});

test('vfsToDisk blocks path traversal', () => {
  assert.throws(() => vfsToDisk('/tmp/project', '/../../etc/passwd'), /escapes/);
  assert.equal(vfsToDisk('/tmp/project', '/app/a.ts'), path.resolve('/tmp/project/app/a.ts'));
});

test('diskToVfs round-trips and rejects outside paths', () => {
  assert.equal(diskToVfs('/tmp/project', '/tmp/project/app/a.ts'), '/app/a.ts');
  assert.equal(diskToVfs('/tmp/project', '/tmp/other/a.ts'), null);
});

test('asset detection and mime table', () => {
  assert.equal(isAssetPath('/a/icon.png'), true);
  assert.equal(isAssetPath('/a/font.woff2'), true);
  assert.equal(isAssetPath('/a/code.tsx'), false);
  assert.equal(isAssetPath('/a/styles.css'), false); // css stays text
  assert.equal(mimeFor('/a/icon.png'), 'image/png');
  assert.equal(mimeFor('/a/unknown.xyz'), 'application/octet-stream');
});
