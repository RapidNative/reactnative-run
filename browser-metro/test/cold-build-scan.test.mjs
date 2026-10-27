// The cold native build scans and parses the whole prebundled dependency set
// (~30 MB). These pin the shortcuts that make that cheap to the exact output of
// the slow path they replace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findRequires, lowerDynamicImports } from "../dist/utils.js";
import { IncrementalBundler, VirtualFS, typescriptTransformer } from "../dist/index.js";

// The pre-optimization findRequires, verbatim: the reference output.
function findRequiresReference(source) {
  if (!source) return [];
  const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const DYNAMIC_IMPORT_RE = /(?<![.$\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const COMMENT_LINE_RE = /^\s*(?:\/\/|\/?\*)/;
  const requires = [];
  for (const line of source.split("\n")) {
    if (COMMENT_LINE_RE.test(line)) continue;
    const reqRe = new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags);
    let match;
    while ((match = reqRe.exec(line)) !== null) requires.push(match[1]);
    const impRe = new RegExp(DYNAMIC_IMPORT_RE.source, DYNAMIC_IMPORT_RE.flags);
    while ((match = impRe.exec(line)) !== null) requires.push(match[1]);
  }
  return requires;
}

const SAMPLES = [
  "",
  'require("a")',
  'var a = require("a"), b = require(\'b\'); import("c"); require("d")',
  '// require("commented")\n * require("jsdoc")\n/* require("block") */\nrequire("real")',
  '  // require("indented comment")\n\trequire("tabbed")',
  'x.import("method"); $import("ident"); import ( "spaced" ); require ( "spaced-req" )',
  'import("first"); require("second") // same line: requires come before imports',
  "no matches here\nnor here\n",
  'require("trailing-no-newline")',
  "\n\n\nrequire(\"after-blank-lines\")\n\n",
  'const s = "require(\\"in-string\\")"; requireX("no"); xrequire("prefix")',
  'require(variable); require(`template`); import(variable)',
  "\r\nrequire(\"crlf\")\r\nimport(\"crlf-imp\")\r\n",
  "import x from 'y';\nexport * from \"z\";\nrequire(\"after-imports\")",
];

test("findRequires matches the line-by-line reference exactly", () => {
  for (const src of SAMPLES) {
    assert.deepEqual(findRequires(src), findRequiresReference(src), JSON.stringify(src));
  }
});

test("findRequires matches the reference on generated sources", () => {
  const parts = [
    'require("p")', "import(\"q\")", "// require(\"c\")", " * import(\"d\")", "foo();", "\n", "\n",
    "require", "import", "(", ")", '"', "'", " ", ".import(\"m\")", "`require(\"t\")`",
  ];
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 500; i++) {
    let src = "";
    for (let j = rand(40); j > 0; j--) src += parts[rand(parts.length)];
    assert.deepEqual(findRequires(src), findRequiresReference(src), JSON.stringify(src));
  }
});

test("lowerDynamicImports leaves code without an import( untouched", () => {
  const src = 'module.exports = require("a"); var o = { import: 1 }; o.import(1);';
  assert.equal(lowerDynamicImports(src), src);
});

test("lowerDynamicImports still lowers real dynamic imports", () => {
  const out = lowerDynamicImports('var p = import("lazy-dep");');
  assert.match(out, /require\("lazy-dep"\)/);
  assert.doesNotMatch(out, /import\("lazy-dep"\)/);
  // Strings that merely mention it are left alone (the AST pass decides).
  const msg = 'throw new Error("Expected the result of a dynamic import() call");';
  assert.equal(lowerDynamicImports(msg), msg);
});

// --- Native second pass ---------------------------------------------------

const FILES = {
  "/package.json": {
    content: JSON.stringify({ name: "t", version: "1.0.0", main: "index.js", dependencies: { "some-lib": "1.0.0" } }),
    isExternal: false,
  },
  "/index.js": { content: 'module.exports = require("some-lib");', isExternal: false },
};

/** A native bundler whose dep bundle has some-lib requiring its own internal
 *  subpath; `inManifest` says whether the server combine-built that subpath. */
function nativeBundler({ inManifest }) {
  const requested = [];
  const manifest = { "some-lib": "1.0.0", ...(inManifest ? { "some-lib/internal": "1.0.0" } : {}) };
  const depBundle =
    `// @dep-bundle x\n// @dep-manifest ${JSON.stringify(manifest)}\n` +
    `// @dep-start some-lib\nmodule.exports = require("some-lib/internal");\n// @dep-end some-lib\n` +
    `// @dep-start some-lib/internal\nmodule.exports = 42;\n// @dep-end some-lib/internal\n`;
  const fakeFetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/bundle-deps")) {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        requested.push(JSON.parse(init.body).subpaths);
        return new Response(depBundle, { status: 200 });
      }
      return new Response("// Not found", { status: 404 });
    }
    return new Response("module.exports = {};", { status: 200 });
  };
  const bundler = new IncrementalBundler(new VirtualFS(structuredClone(FILES)), {
    resolver: { sourceExts: ["ts", "tsx", "js", "jsx"] },
    transformer: typescriptTransformer,
    platform: "ios",
    server: { packageServerUrl: "http://fake.test", fetch: fakeFetch },
  });
  return { bundler, requested };
}

test("native: no second prefetch when the bundle already combine-built the subpath", async () => {
  const { bundler, requested } = nativeBundler({ inManifest: true });
  await bundler.build("/index.js");
  assert.equal(requested.length, 1, `one dependency-bundle request (got ${requested.length})`);
});

test("native: a subpath the bundle lacks still triggers the combined second prefetch", async () => {
  const { bundler, requested } = nativeBundler({ inManifest: false });
  await bundler.build("/index.js");
  assert.equal(requested.length, 2);
  assert.ok(requested[1].includes("some-lib/internal"), "second request folds the subpath in");
});

test("build waits for beforeWalk before reading modules", async () => {
  const { bundler } = nativeBundler({ inManifest: true });
  let released = false;
  const gate = new Promise((r) => setTimeout(() => ((released = true), r()), 50));
  await bundler.build("/index.js", gate);
  assert.ok(released, "build resolved only after the gate");
});
