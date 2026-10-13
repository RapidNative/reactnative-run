import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeviceLog, formatLogArg, formatStackLine, stripAnsi } from '../dist/server/device-log.js';

test('device log bodies lose the ANSI colors RN adds when it pretty-formats an argument', () => {
  assert.equal(stripAnsi('\u001b[31m[Error: boom]\u001b[39m'), '[Error: boom]');
  assert.equal(formatDeviceLog('error', ['\u001b[2mx\u001b[22m', 'y']), '[device:error] x y');
});

test('an error object keeps its name, message and stack instead of becoming {}', () => {
  const err = new TypeError("Cannot read property 'map' of undefined");
  const line = formatLogArg(err);
  assert.match(line, /^TypeError: Cannot read property 'map' of undefined\n/);
  assert.ok(line.includes('device-log.test.mjs'));
  assert.equal(formatLogArg({ name: 'Error', message: 'plain' }), 'Error: plain');
  assert.equal(formatLogArg({ a: 1 }), '{"a":1}');
  assert.equal(formatDeviceLog(undefined, []), '[device:log] ');
});

test('a symbolicated stack becomes one [device:stack] line, top frames first', () => {
  const line = formatStackLine([
    { file: '/app/(app)/product.tsx', lineNumber: 41, column: 12, methodName: 'ProductScreen' },
    { methodName: 'nativeFrame' },
    { file: '/node_modules/react/index.js', lineNumber: 3 },
  ]);
  assert.equal(line, '[device:stack] at ProductScreen (/app/(app)/product.tsx:41:12) | at <anonymous> (/node_modules/react/index.js:3)');
  assert.equal(formatStackLine([{ methodName: 'x' }]), null);
  const many = Array.from({ length: 30 }, (_, i) => ({ file: `/f${i}.js`, lineNumber: i + 1 }));
  assert.equal(formatStackLine(many).split(' | ').length, 12);
});
