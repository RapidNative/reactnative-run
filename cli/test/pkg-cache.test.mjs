import { test } from "node:test";
import assert from "node:assert";
import { isTransientFailure } from "../dist/project/pkg-cache.js";

// Only failures of the package itself may be negative-cached. A server-side
// hiccup cached for an hour keeps projects broken long after it is fixed.

test("server-side disk/network failures are transient", () => {
  for (const body of [
    "// Error bundling expo@^57.0.19\n// bun install failed: ENOSPC: copying file ios/Core/Views/SwiftUI/SwiftUIVirtualView.swift",
    "// Command failed: npm install --ignore-scripts react-native@0.86.3 npm warn tar TAR_ENTRY_ERROR ENOENT",
    "getaddrinfo EAI_AGAIN registry.npmjs.org",
    "read ECONNRESET",
    "bun install timed out",
  ]) {
    assert.strictEqual(isTransientFailure(500, body), true, body);
  }
});

test("gateway statuses are transient whatever the body", () => {
  for (const status of [502, 503, 504, 524]) assert.strictEqual(isTransientFailure(status, ""), true);
});

test("a package that genuinely fails to build is not transient", () => {
  const body = `// Error bundling some-node-lib@1.0.0\n// Build failed with 2 errors:\nERROR: Could not resolve "node:fs"`;
  assert.strictEqual(isTransientFailure(500, body), false);
  assert.strictEqual(isTransientFailure(500, Buffer.from(body)), false);
});
