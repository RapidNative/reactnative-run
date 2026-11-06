import { test } from "node:test";
import assert from "node:assert";
import { IncrementalBundler, VirtualFS, typescriptTransformer } from "../dist/index.js";

// A wrapped package ("<name>" -> override, real code at "<name>__original")
// must survive rebuilds. "<name>__original" is not a package: if a rebuild
// ever asks the package server for it, the server 404s and every rebuild after
// it fails (rnrun, Nov 2026: "Failed to fetch package
// 'expo-sensors__original@^58.0.0'" on each edit of an app using expo-sensors).

const FILES = {
  "/package.json": {
    content: JSON.stringify({
      name: "t",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "some-lib": "1.0.0", other: "1.0.0" },
    }),
    isExternal: false,
  },
  "/index.js": { content: 'require("./a"); module.exports = require("some-lib");', isExternal: false },
  "/a.js": { content: "module.exports = 1;", isExternal: false },
};

const WRAP = {
  name: "wrap-some-lib",
  overrideModules() {
    return { "some-lib": 'var real = require("some-lib__original");\nmodule.exports = { wrapped: true, real: real.real };' };
  },
};

function makeBundler(vfs, requested) {
  const fakeFetch = async (url) => {
    const u = String(url);
    requested.push(u);
    if (u.includes("/bundle-deps")) return new Response("// nope", { status: 404 });
    if (u.includes("__original")) return new Response("// Error bundling: E404", { status: 500 });
    return new Response("// Bundled\nmodule.exports = { real: true };", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  return new IncrementalBundler(vfs, {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
    hmr: { enabled: true },
    plugins: [WRAP],
  });
}

test("rebuilds keep <name>__original and never fetch it", async () => {
  const vfs = new VirtualFS(structuredClone(FILES));
  const requested = [];
  const bundler = makeBundler(vfs, requested);
  await bundler.build("/index.js");
  for (let i = 0; i < 4; i++) {
    vfs.write("/a.js", `module.exports = ${i + 2};`);
    bundler.updateFS(vfs);
    const r = await bundler.rebuild([{ path: "/a.js", type: "update" }]);
    assert.match(r.bundle, /"some-lib__original": function/, `rebuild ${i}: original kept`);
    assert.match(r.bundle, /wrapped: true/, `rebuild ${i}: override kept`);
  }
  // an edit that adds a new npm import (Phase 3 fetches)
  vfs.write("/a.js", 'module.exports = require("other");');
  bundler.updateFS(vfs);
  const r = await bundler.rebuild([{ path: "/a.js", type: "update" }]);
  assert.match(r.bundle, /"some-lib__original": function/);
  assert.match(r.bundle, /wrapped: true/);
  assert.ok(!requested.some((u) => u.includes("__original")), "never asks the server for __original: " + requested.filter((u) => u.includes("__original")));
});

test("an edit that imports the wrapped package again keeps the wrap", async () => {
  const vfs = new VirtualFS(structuredClone(FILES));
  const requested = [];
  const bundler = makeBundler(vfs, requested);
  await bundler.build("/index.js");
  vfs.write("/a.js", 'module.exports = require("some-lib");');
  bundler.updateFS(vfs);
  const r = await bundler.rebuild([{ path: "/a.js", type: "update" }]);
  assert.match(r.bundle, /wrapped: true/);
  // the original is the real package, not the wrapper wrapping itself
  assert.match(r.bundle, /"some-lib__original": function[^]*?real: true/);
  assert.ok(!requested.some((u) => u.includes("__original")));
});
