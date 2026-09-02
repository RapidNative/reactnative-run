import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { toolVersions, packageVersion } from "../dist/project/tool-versions.js";

// The bundle-cache key includes the rnrun + browser-metro versions so an
// upgrade never serves a bundle assembled by the previous release. A lookup
// that throws (browser-metro's `exports` map does not expose package.json)
// used to degrade to "unknown" -- and the fleet kept serving stale bundles
// through a fix rollout because every input still matched.

test("toolVersions resolves both real versions (never 'unknown')", () => {
  const v = toolVersions();
  assert.match(v, /^rnrun@\d+\.\d+\.\d+\S*\+bm@\d+\.\d+\.\d+\S*$/, v);
  assert.ok(!v.includes("unknown"), v);
});

test("packageVersion walks up from the resolved entry, even with an exports map", () => {
  const req = createRequire(import.meta.url);
  assert.throws(() => req("browser-metro/package.json"), /ERR_PACKAGE_PATH_NOT_EXPORTED/, "precondition: the naive lookup throws");
  assert.strictEqual(packageVersion(req, "browser-metro"), req.resolve("browser-metro").includes("browser-metro") ? packageVersion(req, "browser-metro") : null);
  assert.match(packageVersion(req, "browser-metro"), /^\d+\.\d+\.\d+/);
  assert.strictEqual(packageVersion(req, "definitely-not-installed-xyz"), null);
});
