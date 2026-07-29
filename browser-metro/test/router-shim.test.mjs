import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouterShim } from '../dist/utils.js';

/**
 * The router shim is a string of JS that runs inside a blob: document. These tests eval it
 * against a minimal fake of the parts of the DOM it touches, so the route bookkeeping can be
 * asserted without a browser.
 *
 * The case that matters: a blob: URL identifies the document itself, so its path segment is
 * the blob UUID and is never a route. Reading it as one meant that a router calling
 * history.replaceState(state, '', location.href) on init (React Navigation does) latched
 * '/<blob-uuid>' as the current route, which the host then restored on reload — landing the
 * preview on Expo Router's "Unmatched Route". Only a "/" route could hit it, because that is
 * the one mount whose URL carries no fragment to read back.
 */

const BLOB_ID = 'd485d3ca-4f17-4ea1-b8e0-d005314a39fa';
const ORIGIN = 'http://localhost:3000';

/** Run the shim in a sandbox whose location.href is a blob URL with the given fragment. */
function runShim(fragment) {
  const href = `blob:${ORIGIN}/${BLOB_ID}${fragment}`;
  const win = {
    location: {
      href,
      hash: fragment,
      origin: ORIGIN,
    },
    URL: globalThis.URL,
    dispatchEvent: () => true,
    PopStateEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };
  const history = {
    replaceState(state, title, url) {
      // The real replaceState only rewrites the fragment of a blob URL.
      win.location.href = url;
      const i = String(url).indexOf('#');
      win.location.hash = i >= 0 ? String(url).slice(i) : '';
    },
    pushState() {},
    go() {},
    back() {},
    forward() {},
    state: null,
  };
  const sandbox = {
    window: win,
    location: win.location,
    history,
    document: { URL: href },
    Document: { prototype: {} },
    URL: globalThis.URL,
    PopStateEvent: win.PopStateEvent,
  };
  // `window` is also the global inside the iframe.
  Object.assign(win, { history, document: sandbox.document });

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, buildRouterShim())(...keys.map((k) => sandbox[k]));
  return { win, history };
}

test('a "/" mount reports "/" as its route, not the blob uuid', () => {
  const { win } = runShim('');
  assert.equal(win.__ROUTER_SHIM_HASH__, '#/');
});

test('replaceState(location.href) on a "/" mount does NOT latch the blob uuid', () => {
  const { win, history } = runShim('');
  // Exactly what React Navigation does on init.
  history.replaceState({}, '', win.location.href);
  assert.equal(
    win.__ROUTER_SHIM_HASH__,
    '#/',
    'the blob uuid must never become the current route'
  );
  assert.ok(
    !String(win.__ROUTER_SHIM_HASH__).includes(BLOB_ID),
    `route leaked the blob id: ${win.__ROUTER_SHIM_HASH__}`
  );
});

test('replaceState(location.href) on a non-"/" mount keeps its real route', () => {
  const { win, history } = runShim('#/leaderboard');
  assert.equal(win.__ROUTER_SHIM_HASH__, '#/leaderboard');
  history.replaceState({}, '', win.location.href);
  assert.equal(win.__ROUTER_SHIM_HASH__, '#/leaderboard');
});

test('ordinary in-app navigation still updates the route', () => {
  const { win, history } = runShim('');
  history.pushState({}, '', '/my-bets');
  assert.equal(win.__ROUTER_SHIM_HASH__, '#/my-bets');
});

test('a blob url carrying a fragment resolves to that fragment', () => {
  const { win, history } = runShim('');
  history.pushState({}, '', `blob:${ORIGIN}/${BLOB_ID}#/settings`);
  assert.equal(win.__ROUTER_SHIM_HASH__, '#/settings');
});
