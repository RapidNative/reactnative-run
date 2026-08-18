import { test } from "node:test";
import assert from "node:assert";
import { IncrementalBundler, VirtualFS, typescriptTransformer } from "../dist/index.js";

// Prefetch retry classification. A reverse proxy in front of the package
// server (nginx with the default 60s proxy_read_timeout, or a CDN) returns
// 504/524 while the origin is legitimately still compiling -- that means
// "unknown, possibly still building", so the client polls GET instead of
// re-POSTing (which restarts the wait and multiplies upstream work). A 500 is
// the origin reporting the build threw: GET will 404 forever, so fall back
// immediately instead of stalling.

const FILES = {
  "/package.json": {
    content: JSON.stringify({
      name: "t",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "some-lib": "1.0.0" },
    }),
    isExternal: false,
  },
  "/index.js": { content: 'module.exports = require("some-lib");', isExternal: false },
};

function build({ postStatus, gettableAfter = Infinity }) {
  const calls = { get: 0, post: 0 };
  const fakeFetch = async (url, init) => {
    const u = String(url);
    const method = init?.method?.toUpperCase() ?? "GET";
    if (u.includes("/bundle-deps")) {
      if (method === "POST") {
        calls.post++;
        return new Response("upstream timeout", { status: postStatus });
      }
      calls.get++;
      if (calls.get > gettableAfter) {
        return new Response("// @dep-bundle x\n// @dep-start some-lib\nmodule.exports = {};\n// @dep-end some-lib\n", {
          status: 200,
        });
      }
      return new Response("// Not found", { status: 404 });
    }
    return new Response("// Bundled\nmodule.exports = {};", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  const vfs = new VirtualFS(structuredClone(FILES));
  const bundler = new IncrementalBundler(vfs, {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
  });
  return { bundler, calls };
}

test("a 500 from the origin falls back immediately (no polling stall)", async () => {
  const { bundler, calls } = build({ postStatus: 500 });
  const started = Date.now();
  await bundler.build("/index.js");
  assert.ok(Date.now() - started < 2000, `should not poll after a 500 (took ${Date.now() - started}ms)`);
  assert.strictEqual(calls.post, 1, "POSTed once");
  assert.strictEqual(calls.get, 1, "only the initial GET, no polling");
});

test("a gateway 504 polls the GET and never re-POSTs", async () => {
  // GET succeeds on its 2nd call, i.e. the build finished while the proxy had
  // already hung up on the POST.
  const { bundler, calls } = build({ postStatus: 504, gettableAfter: 1 });
  await bundler.build("/index.js");
  assert.strictEqual(calls.post, 1, "exactly one POST -- no retry storm");
  assert.ok(calls.get >= 2, `polled the GET (get calls: ${calls.get})`);
});
