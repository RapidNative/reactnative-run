import { test } from "node:test";
import assert from "node:assert";
import { bundleCacheKey } from "../dist/bundler/bundle-cache.js";

// The cache key must change when any input that affects the bytes changes, and
// stay stable otherwise -- a stale hit serves code that doesn't match the
// project, which is worse than a slow build.

const base = {
  platform: "ios",
  toolVersions: "rnrun@0.3.1+bm@1.4.1",
  files: { "/index.tsx": { content: "export default 1", isExternal: false } },
  env: { EXPO_PUBLIC_X: "1" },
  flags: { nativewind: false, worklets: true },
};

test("identical inputs produce identical keys", () => {
  assert.strictEqual(bundleCacheKey(base), bundleCacheKey(structuredClone(base)));
});

test("a changed source file changes the key", () => {
  const b = structuredClone(base);
  b.files["/index.tsx"].content = "export default 2";
  assert.notStrictEqual(bundleCacheKey(base), bundleCacheKey(b));
});

test("platform, tool versions, env, prelude and flags each change the key", () => {
  for (const mut of [
    (b) => (b.platform = "android"),
    (b) => (b.toolVersions = "rnrun@0.3.2+bm@1.4.1"),
    (b) => (b.env.EXPO_PUBLIC_X = "2"),
    (b) => (b.prelude = "var x=1"),
    (b) => (b.flags.worklets = false),
  ]) {
    const b = structuredClone(base);
    mut(b);
    assert.notStrictEqual(bundleCacheKey(base), bundleCacheKey(b), mut.toString());
  }
});

test("file enumeration order does not affect the key", () => {
  const a = structuredClone(base);
  a.files = { "/a.ts": { content: "a", isExternal: false }, "/b.ts": { content: "b", isExternal: false } };
  const b = structuredClone(base);
  b.files = { "/b.ts": { content: "b", isExternal: false }, "/a.ts": { content: "a", isExternal: false } };
  assert.strictEqual(bundleCacheKey(a), bundleCacheKey(b));
});

test("an external asset's content is ignored but its metadata is not", () => {
  const a = structuredClone(base);
  a.files["/img.png"] = { content: "", isExternal: true };
  a.assetMeta = { "/img.png": { hash: "h1" } };
  const b = structuredClone(a);
  b.assetMeta = { "/img.png": { hash: "h2" } };
  assert.notStrictEqual(bundleCacheKey(a), bundleCacheKey(b), "asset hash must move the key");
});
