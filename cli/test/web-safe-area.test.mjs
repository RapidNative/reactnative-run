import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHtml } from '../dist/server/html.js';

const html = pageHtml({ title: 'app', bundleVersion: 1 });
const script = html
  .split('<script>')
  .map((s) => s.split('</script>')[0])
  .find((s) => s.includes('safeArea='));

test('web page carries the simulated safe-area script, before the bundle', () => {
  assert.ok(script, 'script present');
  assert.ok(html.indexOf('safeArea=') < html.indexOf('/index.bundle?platform=web'));
  assert.doesNotThrow(() => new Function(script));
});

test('safe-area script: env() insets in CSS become the px values from the URL', () => {
  const inserted = [];
  class FakeSheet { insertRule(rule) { inserted.push(rule); return 0; } }
  const head = { appended: [], appendChild(n) { this.appended.push(n); } };
  const g = {
    location: { search: '?safeArea=59,0,34,0' },
    CSSStyleSheet: FakeSheet,
    MutationObserver: class { observe() {} },
    document: { head, documentElement: {}, createElement: () => ({ textContent: '' }) },
  };
  new Function('globalThis', 'location', 'CSSStyleSheet', 'MutationObserver', 'document', script)(
    g, g.location, g.CSSStyleSheet, g.MutationObserver, g.document,
  );
  assert.deepEqual(g.__RNRUN_SAFE_AREA__, { top: 59, right: 0, bottom: 34, left: 0 });
  new FakeSheet().insertRule('.r-1{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom, 8px)}');
  assert.equal(inserted[0], '.r-1{padding-top:59px;padding-bottom:34px}');
  assert.match(head.appended[0].textContent, /padding-top:59px!important/);
});

test('safe-area script: inert without the parameter', () => {
  const g = { location: { search: '' } };
  new Function('globalThis', 'location', script)(g, g.location);
  assert.equal(g.__RNRUN_SAFE_AREA__, undefined);
});
