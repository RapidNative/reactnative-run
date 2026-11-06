import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject } from '../dist/project/scan.js';
import { BundlerSession } from '../dist/bundler/session.js';

// A change to a file no module imports (notes, eas.json, a log) leaves the
// bundle as it was: the session must not advance or tell devices to reload.
// It used to emit "reload" for every such change, and a log file written into
// the project (`rnrun start . > rnrun.log`) reloaded Expo Go every second,
// mid-boot: "Cannot read property 'EventEmitter' of undefined", then
// "main has not been registered".

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plain-app');

for (const platform of ['web', 'ios']) {
  test(`${platform}: an unimported file changing is not a new bundle and reloads nothing`, async () => {
    const { files } = scanProject(FIXTURE);
    const session = new BundlerSession(files, {
      packageServerUrl: 'http://127.0.0.1:0', // the fixture has no npm deps
      env: {},
      platform,
      assetPublicPath: '/__bm_assets',
    });
    assert.equal(await session.build(), true, session.buildError ?? '');
    const events = [];
    session.onEvent((e) => events.push(e.type));
    const version = session.bundleVersion;
    const bundle = session.getBundle();

    await session.applyChanges([{ type: 'create', path: '/notes.txt', content: 'hello' }]);
    await session.applyChanges([{ type: 'update', path: '/notes.txt', content: 'hello again' }]);
    assert.deepEqual(events, []);
    assert.equal(session.bundleVersion, version);
    assert.equal(session.getBundle(), bundle);

    // a real edit still goes through
    const greet = fs.readFileSync(path.join(FIXTURE, 'lib/greet.ts'), 'utf8');
    await session.applyChanges([{ type: 'update', path: '/lib/greet.ts', content: greet.replace('hello', 'howdy') }]);
    assert.equal(session.bundleVersion, version + 1);
    assert.equal(events.length, 1);
    assert.match(session.getBundle(), /howdy/);
  });
}
