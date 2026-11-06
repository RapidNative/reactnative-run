import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  hasUseDomDirective,
  createUseDomNativePlugin,
  domProxySource,
  domEntrySource,
  vfsPathFromFileParam,
  listDomComponents,
  DOM_EVENTS_PATH,
} from '../dist/bundler/dom-components.js';
import { DomComponentSessions } from '../dist/bundler/dom-sessions.js';
import { NATIVE_DEV_CLIENT_SOURCE } from '../dist/bundler/native-dev-client.js';
import { startServer } from '../dist/server/server.js';

const CHART = `"use dom";
import "@/global.css";
import { Chart } from "./Chart";
export default function ChartDom(props) {
  return <div><canvas /></div>;
}
`;

test('"use dom": found in the directive prologue only', () => {
  assert.equal(hasUseDomDirective('"use dom";\nexport default 1'), true);
  assert.equal(hasUseDomDirective("'use dom'\nexport default 1"), true);
  // comments, a hashbang and other directives may come first (babel's program.directives)
  assert.equal(hasUseDomDirective('/**\n * docs\n */\n// more\n"use dom";'), true);
  assert.equal(hasUseDomDirective('#!/usr/bin/env node\n"use dom";'), true);
  assert.equal(hasUseDomDirective('"use client";\n"use dom";\n'), true);
  // anything else first ends the prologue
  assert.equal(hasUseDomDirective('import x from "y";\n"use dom";'), false);
  assert.equal(hasUseDomDirective('const a = "use dom";'), false);
  // an expression, not a directive
  assert.equal(hasUseDomDirective('"use dom".length;'), false);
  assert.equal(hasUseDomDirective('"use dom" + x;'), false);
  assert.equal(hasUseDomDirective('"use domain";'), false);
  assert.equal(hasUseDomDirective(''), false);
});

test('native plugin: a "use dom" module becomes the expo/dom WebView proxy', () => {
  const plugin = createUseDomNativePlugin();
  const out = plugin.transformSource({ src: CHART, filename: '/components/Chart.dom.tsx' });
  assert.ok(out, 'the module is replaced');
  // none of the web code (or its imports) reaches the native bundle
  assert.doesNotMatch(out.src, /global\.css|\.\/Chart"|canvas/);
  assert.match(out.src, /import \{ WebView \} from "expo\/dom\/internal"/);
  // babel-preset-expo's dev filePath: basename?file=<file URL>, read by expo/dom's getBaseURL
  assert.match(out.src, /const filePath = "Chart\.dom\.tsx\?file=file:\/\/\/components\/Chart\.dom\.tsx"/);
  assert.match(out.src, /displayName = "DOM\(ChartDom\)"/);
  assert.match(out.src, /export default _Expo_DOMProxyComponent/);
  // the page is named on the server the bundle came from (anonymous mode)
  assert.match(out.src, /__rnrunDevServerOrigin/);
  assert.match(out.src, /overrideUri: origin \+ "\/_expo\/@dom\/" \+ filePath/);
});

test('native plugin: leaves everything else alone', () => {
  const plugin = createUseDomNativePlugin();
  assert.equal(plugin.transformSource({ src: 'export default 1;\n// "use dom"', filename: '/a.tsx' }), null);
  assert.equal(plugin.transformSource({ src: CHART, filename: '/node_modules/x/a.tsx' }), null);
  assert.equal(plugin.transformSource({ src: CHART, filename: 'some-package' }), null);
  assert.equal(plugin.transformSource({ src: CHART, filename: '/global.css' }), null);
});

test("native plugin: babel-preset-expo's checks", () => {
  const plugin = createUseDomNativePlugin();
  const run = (src, filename = '/components/X.tsx') => plugin.transformSource({ src, filename });
  assert.throws(() => run('"use dom";\nexport function A() {}'), /requires a default export/);
  assert.throws(
    () => run('"use dom";\nexport const x = 1;\nexport default function A() {}'),
    /only support a single default export/
  );
  assert.throws(() => run(CHART, '/app/_layout.tsx'), /Layout routes cannot be marked as DOM components/);
  assert.throws(() => run(CHART, '/app/hello+api.ts'), /API routes cannot be marked as DOM components/);
  // type exports are fine
  assert.ok(run('"use dom";\nexport type P = { a: 1 };\nexport interface Q {}\nexport default () => null;'));
});

test('proxy / entry sources and file URLs', () => {
  assert.match(domProxySource('/a b/C.tsx', 'export default () => null'), /file:\/\/\/a%20b\/C\.tsx/);
  assert.match(domProxySource('/C.tsx', 'export default () => null'), /DOM\(Component\)/);
  assert.equal(
    domEntrySource('/components/Chart.dom.tsx').split('\n')[1],
    'require("expo/dom/internal").registerDOMComponent(require("/components/Chart.dom.tsx").default);'
  );
  assert.equal(vfsPathFromFileParam('file:///components/Chart.dom.tsx'), '/components/Chart.dom.tsx');
  assert.equal(vfsPathFromFileParam('file:///a%20b/C.tsx'), '/a b/C.tsx');
  // a disk path under the project root (a bundle made by Expo's own toolchain)
  assert.equal(vfsPathFromFileParam('file:///srv/app/components/C.tsx', '/srv/app'), '/components/C.tsx');
  assert.equal(vfsPathFromFileParam('file:///components/../../etc/passwd'), null);
  assert.equal(vfsPathFromFileParam('/components/C.tsx'), null);
  assert.equal(vfsPathFromFileParam(null), null);
  assert.deepEqual(
    listDomComponents(Object.entries({ '/b.tsx': CHART, '/a.tsx': 'export default 1', '/c.ts': '"use dom";' })),
    ['/b.tsx', '/c.ts']
  );
});

test('dev client records the server origin for DOM components', () => {
  assert.match(NATIVE_DEV_CLIENT_SOURCE, /g\.__rnrunDevServerOrigin = origin;/);
});

// --- routes, with stub sessions (the real ones need the package server) ---

function stubSession(domEntry, files) {
  let version = 0;
  const s = {
    domEntry,
    builds: 0,
    buildError: null,
    bundle: '',
    get bundleTag() {
      return `tag-${version}`;
    },
    getBundle: () => s.bundle,
    async ensureBuilt() {
      s.builds++;
      const src = files[domEntry]?.content ?? '';
      if (src.includes('SYNTAX ERROR')) {
        s.buildError = 'SyntaxError: boom';
        return false;
      }
      s.bundle = `/* bundle of ${domEntry} */\n${src}`;
      version++;
      return true;
    },
    async applyChanges(changes) {
      for (const c of changes) files[c.path] = { content: c.content ?? '' };
      if (changes.some((c) => c.path === domEntry || c.path === '/components/Chart.tsx')) {
        s.bundle = `/* bundle of ${domEntry} */\n${files[domEntry]?.content ?? ''} ${Math.random()}`;
        version++;
      }
    },
  };
  return s;
}

let dev;
let base;
let dom;
const made = [];

before(async () => {
  const files = {
    '/package.json': { content: '{"name":"dom-app"}' },
    '/components/Chart.dom.tsx': { content: CHART },
    '/components/Chart.tsx': { content: 'export function Chart() { return null; }' },
    '/components/Plain.tsx': { content: 'export default function Plain() { return null; }' },
    '/components/Broken.dom.tsx': { content: '"use dom";\nSYNTAX ERROR' },
  };
  dom = new DomComponentSessions(files, (entry, f) => {
    const s = stubSession(entry, structuredClone(f));
    made.push(s);
    return s;
  });
  const ctx = {
    session: { onEvent: () => () => {}, bundleVersion: 0, buildError: null, getBundle: () => '', ensureBuilt: async () => true },
    config: { app: { name: 'Dom App', slug: 'dom-app' }, env: {}, pkg: { dependencies: {} } },
    rootDir: '/srv/dom-app',
    title: 'Dom App',
    port: 0,
    log: () => {},
    domComponents: dom,
  };
  dev = await startServer(ctx, '127.0.0.1');
  base = `http://127.0.0.1:${dev.port}`;
});

after(async () => {
  await dev?.close();
});

const pageUrl = (file) => `${base}/_expo/@dom/x.tsx?file=${encodeURIComponent(file)}`;

test('GET /_expo/@dom/<name>?file= serves the DOM page (expo/dom contract)', async () => {
  const res = await fetch(pageUrl('file:///components/Chart.dom.tsx'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  // what @expo/cli's page does: read the WebView's injected object before the bundle
  assert.match(html, /window\.ReactNativeWebView\.injectedObjectJson\(\)/);
  assert.match(html, /window\.\$\$EXPO_DOM_HOST_OS = injectedObject\.EXPO_DOM_HOST_OS/);
  assert.match(html, /window\.\$\$EXPO_INITIAL_PROPS = injectedObject\.initialProps/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /globalThis\.__DEV__ = true/);
  const src = /<script crossorigin src="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  assert.match(src, /^\/__rnrun\/dom-bundle\/Chart\.dom\.tsx\.js\?file=/);

  const js = await fetch(base + src);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /bundle of \/components\/Chart\.dom\.tsx/);
});

test('the page also takes the disk path a bundle from Expo would send', async () => {
  const res = await fetch(pageUrl('file:///srv/dom-app/components/Chart.dom.tsx'));
  assert.equal(res.status, 200);
  assert.equal(made.filter((s) => s.domEntry === '/components/Chart.dom.tsx').length, 1, 'one session per component');
});

test('bad requests: no file 400, a non-DOM module 404, a failed build is an error page', async () => {
  assert.equal((await fetch(`${base}/_expo/@dom/x.tsx`)).status, 400);
  assert.equal((await fetch(pageUrl('/components/Chart.dom.tsx'))).status, 400);
  assert.equal((await fetch(pageUrl('file:///components/Plain.tsx'))).status, 404);
  assert.equal((await fetch(pageUrl('file:///components/Missing.tsx'))).status, 404);
  assert.equal((await fetch(pageUrl('file:///components/../package.json'))).status, 400);
  assert.equal((await fetch(`${base}/__rnrun/dom-bundle/x.js?file=${encodeURIComponent('file:///components/Plain.tsx')}`)).status, 404);
  const broken = await fetch(pageUrl('file:///components/Broken.dom.tsx'));
  assert.equal(broken.status, 200);
  const html = await broken.text();
  assert.match(html, /DOM component build error/);
  assert.match(html, /SyntaxError: boom/);
  // a failed build is retried by the next request, not replayed
  await fetch(pageUrl('file:///components/Broken.dom.tsx'));
  assert.equal(made.filter((s) => s.domEntry === '/components/Broken.dom.tsx').length, 2);
});

function openEvents(file) {
  const ws = new WebSocket(`ws://127.0.0.1:${dev.port}${DOM_EVENTS_PATH}?file=${encodeURIComponent(file)}`);
  const messages = [];
  const waiters = [];
  ws.on('message', (m) => {
    messages.push(JSON.parse(String(m)));
    for (const w of waiters.splice(0)) w();
  });
  const next = (type, ms = 3000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${type} message`)), ms);
      const check = () => {
        const i = messages.findIndex((m) => m.type === type);
        if (i === -1) return waiters.push(check);
        clearTimeout(t);
        resolve(messages.splice(i, 1)[0]);
      };
      check();
    });
  return { ws, next, messages };
}

test('an edit that changes the DOM bundle reloads its page; others do not', async () => {
  const chart = openEvents('file:///components/Chart.dom.tsx');
  const hello = await chart.next('hello');
  assert.match(hello.version, /^tag-/);

  // unrelated file: bundle unchanged, no reload
  await dom.applyChanges([{ type: 'update', path: '/components/Plain.tsx', content: 'export default 2' }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(chart.messages.filter((m) => m.type === 'reload').length, 0);

  // a file the component imports
  await dom.applyChanges([{ type: 'update', path: '/components/Chart.tsx', content: 'export function Chart() { return 1; }' }]);
  await chart.next('reload');

  // dropping the directive: the page reloads (and then 404s)
  await dom.applyChanges([{ type: 'update', path: '/components/Chart.dom.tsx', content: 'export default 1' }]);
  await chart.next('reload');
  assert.equal((await fetch(pageUrl('file:///components/Chart.dom.tsx'))).status, 404);
  chart.ws.close();
});

test('the page waits for an edit in flight and is built from the edited files', async () => {
  const p = dom.applyChanges([{ type: 'create', path: '/components/New.dom.tsx', content: '"use dom";\nexport default function N() { return "NEW"; }' }]);
  const res = await fetch(pageUrl('file:///components/New.dom.tsx'));
  assert.equal(res.status, 200);
  await p;
  const html = await res.text();
  const src = /<script crossorigin src="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  assert.match(await (await fetch(base + src)).text(), /NEW/);
});

test('reset (a re-init) reloads every open page', async () => {
  await fetch(pageUrl('file:///components/New.dom.tsx'));
  const page = openEvents('file:///components/New.dom.tsx');
  await page.next('hello');
  dom.reset({ '/components/New.dom.tsx': { content: '"use dom";\nexport default function N() { return "AGAIN"; }' } });
  await page.next('reload');
  page.ws.close();
});
