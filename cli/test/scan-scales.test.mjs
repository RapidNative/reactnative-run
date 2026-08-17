import { test } from "node:test";
import assert from "node:assert";
import { groupScaleVariants } from "../dist/project/scan.js";

test("groups @2x/@3x variants into one asset with DP dimensions", () => {
  const files = {
    "/img/icon.png": { content: "", isExternal: true },
    "/img/icon@2x.png": { content: "", isExternal: true },
    "/img/icon@3x.png": { content: "", isExternal: true },
  };
  const meta = {
    "/img/icon.png": { hash: "h1", width: 60, height: 60 },
    "/img/icon@2x.png": { hash: "h2", width: 120, height: 120 },
    "/img/icon@3x.png": { hash: "h3", width: 180, height: 180 },
  };
  groupScaleVariants(files, meta);
  assert.deepStrictEqual(meta["/img/icon.png"].scales, [1, 2, 3]);
  assert.deepStrictEqual(meta["/img/icon.png"].fileHashes, ["h1", "h2", "h3"]);
  assert.strictEqual(meta["/img/icon.png"].width, 60);
});

test("synthesizes a base VFS entry when only scaled files exist, dims scaled down", () => {
  const files = { "/a@2x.png": { content: "", isExternal: true } };
  const meta = { "/a@2x.png": { hash: "h2", width: 120, height: 80 } };
  groupScaleVariants(files, meta);
  assert.ok(files["/a.png"], "base entry created");
  assert.strictEqual(files["/a.png"].isExternal, true);
  assert.deepStrictEqual(meta["/a.png"].scales, [2]);
  assert.strictEqual(meta["/a.png"].width, 60);
  assert.strictEqual(meta["/a.png"].height, 40);
});

test("plain assets are untouched", () => {
  const files = { "/b.png": { content: "", isExternal: true } };
  const meta = { "/b.png": { hash: "h", width: 10, height: 10 } };
  groupScaleVariants(files, meta);
  assert.strictEqual(meta["/b.png"].scales, undefined);
  assert.strictEqual(meta["/b.png"].width, 10);
});
