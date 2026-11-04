// pdfjs-dist 6 writes `await import("${url}");` inside a template literal (its CDN worker wrapper). The
// dependency scan must not take it for a package: the bundle failed with "Failed to fetch package '${url}'
// (HTTP 400): Invalid package specifier" (Careero Compass, Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findRequires } from "../dist/utils.js";

test("a template interpolation inside a string is not a dependency", () => {
  const pdfjs = [
    "this._createCDNWrapper = url => {",
    '  const wrapper = `await import("${url}");`;',
    '  return URL.createObjectURL(new Blob([wrapper], { type: "text/javascript" }));',
    "};",
    'const x = require(`${base}/y`);',
    'const real = await import("./worker.mjs");',
    'const dep = require("react");',
  ].join("\n");
  assert.deepEqual(findRequires(pdfjs), ["./worker.mjs", "react"]);
});
