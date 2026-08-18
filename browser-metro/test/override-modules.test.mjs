import { test } from "node:test";
import assert from "node:assert";
import { IncrementalBundler, VirtualFS, typescriptTransformer } from "../dist/index.js";

// overrideModules replaces a FETCHED npm module while keeping the original
// reachable at "<name>__original", so a wrapper can delegate to it. Used by
// rnrun to wrap react/jsx-runtime for nativewind on native (Metro aliases
// that module globally, so package-internal JSX resolves className styles).

const FILES = {
  "/package.json": {
    content: JSON.stringify({
      name: "t",
      version: "1.0.0",
      main: "index.js",
      dependencies: { react: "19.1.0", "some-lib": "1.0.0" },
    }),
    isExternal: false,
  },
  "/index.js": { content: 'module.exports = require("some-lib");', isExternal: false },
};

function makeBundler(vfs, plugins) {
  const fakeFetch = async (url) => {
    if (String(url).includes("/bundle-deps")) return new Response("// nope", { status: 404 });
    return new Response('// Bundled\nmodule.exports = { real: true };', {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  return new IncrementalBundler(vfs, {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
    plugins,
  });
}

test("overrideModules wraps a fetched module and preserves the original", async () => {
  const vfs = new VirtualFS(structuredClone(FILES));
  const plugin = {
    name: "wrap-some-lib",
    overrideModules() {
      return {
        "some-lib":
          'var real = require("some-lib__original");\nmodule.exports = { wrapped: true, real: real.real };',
      };
    },
  };
  const result = await makeBundler(vfs, [plugin]).build("/index.js");
  assert.match(result.bundle, /"some-lib__original": function/, "original preserved under __original");
  assert.match(result.bundle, /wrapped: true/, "override code emitted");
});

test("requires introduced by override code are fetched", async () => {
  const vfs = new VirtualFS(structuredClone(FILES));
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/bundle-deps")) return new Response("// nope", { status: 404 });
    return new Response("// Bundled\nmodule.exports = {};", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  const bundler = new IncrementalBundler(vfs, {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
    plugins: [
      {
        name: "wrap-with-new-dep",
        overrideModules() {
          return {
            "some-lib":
              'var helper = require("brand-new-dep");\nmodule.exports = require("some-lib__original");',
          };
        },
      },
    ],
  });
  const result = await bundler.build("/index.js");
  assert.ok(requested.some((u) => u.includes("brand-new-dep")), "new dep fetched");
  assert.match(result.bundle, /"brand-new-dep": function/);
});
