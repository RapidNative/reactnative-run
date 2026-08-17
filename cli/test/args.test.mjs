import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../dist/args.js';

const FLAGS = [
  { name: '--port', type: 'number', default: 8081, description: '' },
  { name: '--package-server', type: 'string', default: 'https://esm.reactnative.run', description: '' },
  { name: '--local-packages', type: 'boolean', default: false, description: '' },
];

test('flags work regardless of positional order (the lifo footgun)', () => {
  const a = parseArgs(['start', '--port', '8082', 'myapp'], FLAGS);
  assert.equal(a.command, 'start');
  assert.equal(a.dir, 'myapp');
  assert.equal(a.flags.port, 8082);

  const b = parseArgs(['start', 'myapp', '--port', '8082'], FLAGS);
  assert.deepEqual(b, a);
});

test('defaults, =-syntax, booleans, kebab-to-camel', () => {
  const a = parseArgs(['start'], FLAGS);
  assert.equal(a.dir, '.');
  assert.equal(a.flags.port, 8081);
  assert.equal(a.flags.localPackages, false);

  const b = parseArgs(['start', '--port=9000', '--local-packages', '--package-server=http://x'], FLAGS);
  assert.equal(b.flags.port, 9000);
  assert.equal(b.flags.localPackages, true);
  assert.equal(b.flags.packageServer, 'http://x');
});

test('unknown flags and bad numbers throw', () => {
  assert.throws(() => parseArgs(['start', '--nope'], FLAGS), /Unknown flag/);
  assert.throws(() => parseArgs(['start', '--port', 'abc'], FLAGS), /expects a number/);
  assert.throws(() => parseArgs(['start', '--port'], FLAGS), /requires a value/);
});
