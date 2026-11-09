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
  assert.deepStrictEqual(Object.keys(body.content).sort(), ["/app/index.tsx", "/package.json", "/tailwind.config.js"]);

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

// tailwind.config.js runs on the server with plain Node `require`, so a JSON
// file it requires must travel with the request. Without it the server 500'd
// with "Cannot find module './text-scale.json'" and the app booted unstyled
// (rnrun only; Lifo's artboard compiles tailwind locally, so it looked fine).
test("JSON files the tailwind config can require are sent; lockfiles are not", async () => {
  let captured;
  const fetch = async (url, init) => {
    captured = init;
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };
  const withJson = {
    ...files,
    "/tailwind.config.js": "const { scale } = require('./text-scale.json');\nmodule.exports = { darkMode: 'class', content: [] };",
    "/text-scale.json": '{\n  "scale": 0.82\n}\n',
    "/package-lock.json": '{ "lockfileVersion": 3 }',
  };
  await compileNativewindCss({ vfs: fakeVfs(withJson), platform: "ios", packageServerUrl: "https://esm.example", fetch, warn: () => {} });
  const body = JSON.parse(gunzipSync(captured.body).toString("utf8"));
  assert.strictEqual(body.content["/text-scale.json"], withJson["/text-scale.json"]);
  assert.ok(!("/package-lock.json" in body.content), "lockfile stays out of the request");
});

// One css file the server can't compile must not take the others' styles with
// it. Full Swing KIT (Nov 2026): css-interop threw in parseAspectRatio on a
// web-only stylesheet (src/lib/rn/source.css, imported only by .web.tsx and
// "use dom" files, which Metro never compiles for native). rnrun dropped
// global.css with it and Expo Go rendered a black screen: every className
// unstyled, flex-1 / min-h layouts collapsed to zero size.
test("a css file that fails to compile becomes an empty module; the others keep their styles", async () => {
  const twoCss = { ...files, "/src/lib/rn/source.css": ".fs-num { font-weight: 800; }" };
  const warnings = [];
  const failed = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(gunzipSync(init.body).toString("utf8"));
    if (body.css.includes(".fs-num")) {
      return new Response(
        JSON.stringify({ error: "Command failed: node runner.cjs /work android\nTypeError: Cannot read properties of undefined (reading '0')\n    at parseAspectRatio" }),
        { status: 500 }
      );
    }
    return new Response(JSON.stringify({ data: { $compiled: true, flags: { darkMode: "class dark" } } }), { status: 200 });
  };
  const out = await compileNativewindCss({ vfs: fakeVfs(twoCss), platform: "android", packageServerUrl: "https://esm.example", fetch, warn: (m) => warnings.push(m), failed });
  assert.ok(out, "partial success is a result, not null");
  assert.match(out.get("/global.css"), /injectData\(.*"darkMode":"class dark"/);
  assert.match(out.get("/src/lib/rn/source.css"), /module\.exports = \{\};/);
  assert.doesNotMatch(out.get("/src/lib/rn/source.css"), /injectData/);
  assert.deepStrictEqual(failed, ["/src/lib/rn/source.css"]);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /\[android\] compile failed for \/src\/lib\/rn\/source\.css \(HTTP 500\): TypeError: Cannot read properties of undefined/);
});

test("when every css file fails, the result is null (previous modules kept)", async () => {
  const twoCss = { ...files, "/b.css": ".x { color: red; }" };
  const failed = [];
  const fetch = async () => new Response("boom", { status: 502 });
  const out = await compileNativewindCss({ vfs: fakeVfs(twoCss), platform: "ios", packageServerUrl: "https://esm.example", fetch, warn: () => {}, failed });
  assert.strictEqual(out, null);
  assert.deepStrictEqual(failed.sort(), ["/b.css", "/global.css"]);
});

import { reduceTailwindContent, CONTENT_REDUCE_ABOVE } from "../dist/project/nativewind.js";

test("a large app's content is sent as its class candidates, deduplicated per folder and extension (RingCode: HTTP 413)", () => {
  const content = {
    "/app/index.tsx": `export default function A() { return <View className="flex-1 bg-[url('/a.png')] grid-cols-[repeat(2,1fr)]">{x}</View>; }`,
    "/app/other.tsx": `export default function B() { return <View className={\`flex-1 \${on ? "md:hover:bg-black/70" : ""}\`} />; }`,
    "/src/lib/x.ts": `const c = "flex-1 [&>svg]:size-4";`,
    "/theme.json": `{ "a": 1 }`,
  };
  const out = reduceTailwindContent(content);
  const toks = (p) => out[p].split("\n");
  // every candidate survives, at a path in its own folder
  assert.ok(toks("/app/index.tsx").some((t) => t.includes("bg-[url('/a.png')]")));
  assert.ok(toks("/app/index.tsx").some((t) => t.includes("grid-cols-[repeat(2,1fr)]")));
  assert.ok(toks("/app/other.tsx").some((t) => t.includes("md:hover:bg-black/70")));
  assert.ok(toks("/src/lib/x.ts").includes("flex-1"), "another folder keeps its own copy");
  assert.ok(toks("/src/lib/x.ts").includes("[&>svg]:size-4"));
  // the same folder and extension doesn't repeat it
  assert.ok(!toks("/app/other.tsx").includes("flex-1"));
  // config data goes as it is
  assert.equal(out["/theme.json"], content["/theme.json"]);
  assert.ok(CONTENT_REDUCE_ABOVE >= 1_000_000);
});

test("the compile request keeps a small app's sources as they are, and reduces a large app's", async () => {
  const sent = async (vfsFiles) => {
    let body;
    const fetch = async (_url, init) => {
      body = JSON.parse(gunzipSync(init.body).toString("utf8"));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    await compileNativewindCss({ vfs: fakeVfs(vfsFiles), platform: "ios", packageServerUrl: "https://esm.example", fetch, warn: () => {} });
    return body.content;
  };
  const small = await sent(files);
  assert.strictEqual(small["/app/index.tsx"], files["/app/index.tsx"]);
  const big = { ...files, "/app/big.tsx": `const s = "${"word ".repeat(1_000_000)}";\nexport default () => <View className="p-4 text-primary" />;` };
  const large = await sent(big);
  assert.ok(large["/app/big.tsx"].length < 1000, "deduplicated to a few tokens");
  assert.ok(large["/app/big.tsx"].split("\n").some((t) => t.includes("text-primary")));
});

test("the reduced content keeps tailwind.config.js, root files and what the config requires as code (RingCode: HTTP 500)", () => {
  const content = {
    "/tailwind.config.js": `const tokens = require("./src/theme/tokens");\nmodule.exports = { content: ["./src/**/*.tsx"], theme: { extend: tokens } };`,
    "/src/theme/tokens.js": `module.exports = { colors: { brand: "#123456" } };`,
    "/src/theme/colors.ts": `export const c = "text-brand";`,
    "/App.tsx": `export default () => <View className="p-4" />;`,
    "/src/app.tsx": `export default () => <View className="p-4" />;`,
  };
  const out = reduceTailwindContent(content, content["/tailwind.config.js"]);
  assert.strictEqual(out["/tailwind.config.js"], content["/tailwind.config.js"]);
  assert.strictEqual(out["/src/theme/tokens.js"], content["/src/theme/tokens.js"]);
  assert.strictEqual(out["/App.tsx"], content["/App.tsx"]);
  assert.notStrictEqual(out["/src/app.tsx"], content["/src/app.tsx"], "a source file in a folder is reduced");
  assert.ok(out["/src/app.tsx"].split("\n").some((t) => t.includes("p-4")));
});
