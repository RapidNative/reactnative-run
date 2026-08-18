// Retention safety. These assertions exist because deleting cache files by
// hand once removed ~450 production web bundles: the sweeper must only ever
// touch files it recognises, and never something recently used.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepGroup, cacheGroups } from "../src/retention";

function tmpCache(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "retention-test-"));
}

/** Write a file with a specific size and last-used age. */
function seed(dir: string, name: string, bytes: number, ageHours: number): string {
	const full = path.join(dir, name);
	fs.writeFileSync(full, Buffer.alloc(bytes, 0x61));
	const when = new Date(Date.now() - ageHours * 3600_000);
	fs.utimesSync(full, when, when);
	return full;
}

test("evicts least-recently-used until under budget", () => {
	const dir = tmpCache();
	seed(dir, "bundle-deps-old.js", 1000, 48);
	seed(dir, "bundle-deps-mid.js", 1000, 24);
	seed(dir, "bundle-deps-new.js", 1000, 12);
	const r = sweepGroup({ label: "t", dir, match: /^bundle-deps-.*\.js$/, budgetBytes: 2000 });
	assert.equal(r.evicted, 1, "one file evicted to get under budget");
	assert.equal(fs.existsSync(path.join(dir, "bundle-deps-old.js")), false, "oldest went first");
	assert.equal(fs.existsSync(path.join(dir, "bundle-deps-mid.js")), true);
	assert.equal(fs.existsSync(path.join(dir, "bundle-deps-new.js")), true);
});

test("never evicts a file younger than the minimum age, even over budget", () => {
	const dir = tmpCache();
	seed(dir, "bundle-deps-a.js", 5000, 0.1); // 6 minutes old
	seed(dir, "bundle-deps-b.js", 5000, 0.2);
	const r = sweepGroup({ label: "t", dir, match: /^bundle-deps-.*\.js$/, budgetBytes: 1 });
	assert.equal(r.evicted, 0, "recent files are untouchable regardless of budget");
	assert.equal(fs.readdirSync(dir).length, 2);
});

test("only touches files matching the group pattern", () => {
	const dir = tmpCache();
	seed(dir, "bundle-deps-x.js", 5000, 48);
	seed(dir, "react-native@0.81.4.js", 5000, 48); // a /pkg output, different group
	seed(dir, "prelude-0.81.4.js", 5000, 48);
	fs.mkdirSync(path.join(dir, "chunks"));
	sweepGroup({ label: "t", dir, match: /^bundle-deps-.*\.js$/, budgetBytes: 1 });
	assert.equal(fs.existsSync(path.join(dir, "react-native@0.81.4.js")), true, "other namespaces untouched");
	assert.equal(fs.existsSync(path.join(dir, "prelude-0.81.4.js")), true, "preludes untouched");
	assert.equal(fs.existsSync(path.join(dir, "chunks")), true, "directories untouched");
});

test("dry run reports without deleting", () => {
	const dir = tmpCache();
	seed(dir, "bundle-deps-a.js", 5000, 48);
	const r = sweepGroup({ label: "t", dir, match: /^bundle-deps-.*\.js$/, budgetBytes: 1 }, { dryRun: true });
	assert.equal(r.evicted, 1, "reported");
	assert.equal(fs.existsSync(path.join(dir, "bundle-deps-a.js")), true, "but nothing deleted");
});

test("the /pkg group excludes combined bundles, preludes and nativewind data", () => {
	const pkgGroup = cacheGroups("/tmp/x").find((g) => g.label === "per-package /pkg output")!;
	assert.equal(pkgGroup.match.test("react-native@0.81.4.ios.nv3.js"), true);
	assert.equal(pkgGroup.match.test("bundle-deps-abc123.js"), false);
	assert.equal(pkgGroup.match.test("prelude-0.81.4.js"), false);
	assert.equal(pkgGroup.match.test("nativewind-abc.json"), false);
});
