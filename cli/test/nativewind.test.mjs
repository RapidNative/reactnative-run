import { test } from "node:test";
import assert from "node:assert";
import { gunzipSync } from "node:zlib";
import { compileNativewindCss, encodeNativewindRequest } from "../dist/project/nativewind.js";

// The /nativewind-css request carries every source file for tailwind's content
// scan. Uncompressed, a mid-sized app passes 1MB and the nginx in front of the
// package server answers 413 (Express' own limit is 10mb) -- the app then boots
// with no compiled styles and nativewind throws "Unable to manually set color
// scheme without using darkMode: class" on the first setColorScheme(). The body
// is therefore sent gzipped, which body-parser inflates transparently.

function fakeVfs(files) {
  return {
    list: () => Object.keys(files),
    read: (p) => files[p],
    exists: (p) => p in files,
  };
}

const files = {
  "/package.json": JSON.stringify({
    dependencies: { nativewind: "4.2.1", tailwindcss: "3.4.18", "react-native-css-interop": "0.2.1", "react-native": "0.81.4" },
  }),
  "/tailwind.config.js": "module.exports = { darkMode: 'class', content: [] };",
  "/global.css": "@tailwind base;",
  "/app/index.tsx": "export default () => <View className='bg-background' />;\n" + "// ".repeat(400_000),
  "/notes.md": "not scanned",
};

test("compile request is gzipped and decodes to the full JSON body", async () => {
  let captured;
  const fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ data: { $compiled: true, flags: { darkMode: "class dark" } } }), { status: 200 });
  };
  const out = await compileNativewindCss({ vfs: fakeVfs(files), platform: "android", packageServerUrl: "https://esm.example", fetch, warn: () => {} });

  assert.ok(captured, "fetch was called");
  assert.strictEqual(captured.url, "https://esm.example/nativewind-css");
  assert.strictEqual(captured.init.headers["content-encoding"], "gzip");
  assert.ok(captured.init.body instanceof Uint8Array, "body is bytes, not a string");
  const raw = Buffer.from(files["/app/index.tsx"]).length;
  assert.ok(raw > 1_000_000, "fixture exceeds the 1MB nginx default");
  assert.ok(captured.init.body.length < raw / 5, `gzipped body (${captured.init.body.length}) should be far under the raw size (${raw})`);

  const body = JSON.parse(gunzipSync(captured.init.body).toString("utf8"));
  assert.strictEqual(body.platform, "android");
  assert.deepStrictEqual(body.versions, { nativewind: "4.2.1", tailwindcss: "3.4.18", "react-native-css-interop": "0.2.1", "react-native": "0.81.4" });
  assert.strictEqual(body.tailwindConfig, files["/tailwind.config.js"]);
  assert.strictEqual(body.css, files["/global.css"]);
  assert.deepStrictEqual(Object.keys(body.content).sort(), ["/app/index.tsx", "/tailwind.config.js"]);

  assert.ok(out.get("/global.css").includes('"darkMode":"class dark"'), "compiled flags reach the injectData module");
});

test("a 413 keeps previous styles and names the payload size in the warning", async () => {
  const warnings = [];
  const fetch = async () => new Response("too large", { status: 413 });
  const out = await compileNativewindCss({ vfs: fakeVfs(files), platform: "ios", packageServerUrl: "https://esm.example", fetch, warn: (m) => warnings.push(m) });
  assert.strictEqual(out, null);
  assert.match(warnings[0], /HTTP 413 -- request body \d+KB gzipped \(\d+KB raw\)/);
  assert.match(warnings[0], /darkMode flags will be missing/);
});

test("encodeNativewindRequest is deterministic (cache key stability)", () => {
  const a = encodeNativewindRequest({ x: 1, content: { "/a.tsx": "hi" } });
  const b = encodeNativewindRequest({ x: 1, content: { "/a.tsx": "hi" } });
  assert.deepStrictEqual(Buffer.from(a.bytes), Buffer.from(b.bytes));
  assert.strictEqual(a.rawBytes, Buffer.byteLength(JSON.stringify({ x: 1, content: { "/a.tsx": "hi" } })));
});
