import { test } from "node:test";
import assert from "node:assert";
import {
  IncrementalBundler,
  VirtualFS,
  createExpoWebShimsPlugin,
  createUnsupportedWebPackagesPlugin,
  typescriptTransformer,
} from "../dist/index.js";

// Regression: requires INSIDE shim module code must be fetched. The web
// react-native shim re-exports react-native-web; when shims were injected
// after the transitive-dep scan, react-native-web was never registered and
// every RN web bundle threw "Module not found: react-native-web" at runtime.

function makeBundler(vfs, requested) {
  const fakeFetch = async (url, init) => {
    requested.push(String(url));
    if (String(url).includes("/bundle-deps")) return new Response("// Not found", { status: 404 });
    return new Response("// Bundled: x\nmodule.exports = {};", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  };
  return new IncrementalBundler(vfs, {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
    hmr: { enabled: true, reactRefresh: true },
    plugins: [createExpoWebShimsPlugin(), createUnsupportedWebPackagesPlugin()],
  });
}

const FILES = {
  "/package.json": {
    content: JSON.stringify({
      name: "t",
      version: "1.0.0",
      main: "index.js",
      dependencies: { react: "19.1.0", "react-native": "0.81.4", "react-native-web": "0.21.1" },
    }),
    isExternal: false,
  },
  "/index.js": { content: 'const RN = require("react-native"); module.exports = RN;', isExternal: false },
};

test("web build registers packages required by shim code (react-native-web)", async () => {
  const requested = [];
  const vfs = new VirtualFS(structuredClone(FILES));
  const bundler = makeBundler(vfs, requested);
  const result = await bundler.build("/index.js");
  assert.ok(
    requested.some((u) => u.includes("react-native-web")),
    "react-native-web fetched"
  );
  assert.match(result.bundle, /"react-native-web": function/);
});

test("rebuild keeps shim-required packages registered", async () => {
  const vfs = new VirtualFS(structuredClone(FILES));
  const bundler = makeBundler(vfs, []);
  await bundler.build("/index.js");
  vfs.write("/index.js", 'const RN = require("react-native"); module.exports = { RN };');
  bundler.updateFS(vfs);
  const result = await bundler.rebuild([{ path: "/index.js", type: "update" }]);
  assert.match(result.bundle, /"react-native-web": function/);
});
