#!/usr/bin/env node
/**
 * Benchmark rnrun against the Expo dev server on the same project.
 *
 * Usage:
 *   node bench/compare.mjs <projectDir>              # rnrun only
 *   node bench/compare.mjs <projectDir> --compare    # rnrun vs `npx expo start`
 *   node bench/compare.mjs <projectDir> --edits 20 --json out.json
 *
 * Metrics (per server):
 *   - cold start:            spawn -> /status responds
 *   - time to first bundle:  first successful GET of the web bundle
 *   - rebuild latency:       file write -> updated bundle observable over HTTP,
 *                            median/p95 over N scripted edits (uniform metric,
 *                            protocol-agnostic, fair to both servers)
 *   - memory:                RSS of the whole process tree at ready, after
 *                            first bundle, after the edit storm, and the peak
 *                            observed while polling. rnrun runs against the
 *                            HOSTED package server (esm.reactnative.run), so
 *                            package-server memory is deliberately excluded --
 *                            it is shared infrastructure, not per-developer
 *                            footprint (expo's Metro has no equivalent split).
 *   - install footprint:     du of the tool's dependency closure
 *
 * The `--compare` project must have node_modules installed (expo needs it;
 * rnrun does not). Requires macOS/Linux `ps` and `du`.
 */
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const projectDir = path.resolve(args.find((a) => !a.startsWith("--")) || ".");
const compare = args.includes("--compare");
const edits = Number(args[args.indexOf("--edits") + 1]) || 20;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const RNRUN_PORT = 8123;
const EXPO_PORT = 8124;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RNRUN_BIN = path.join(HERE, "../dist/bin.js");

// --- helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function treeRssKb(rootPid) {
  // Sum RSS of the root process and all descendants (expo spawns children).
  try {
    const out = execSync("ps -Ao pid,ppid,rss", { encoding: "utf8" });
    const rows = out.trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/).map(Number));
    const children = new Map();
    for (const [pid, ppid] of rows) {
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const rssByPid = new Map(rows.map(([pid, , rss]) => [pid, rss]));
    let total = 0;
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += rssByPid.get(pid) || 0;
      for (const c of children.get(pid) || []) stack.push(c);
    }
    return total;
  } catch {
    return 0;
  }
}

async function waitFor(fn, timeoutMs, intervalMs = 150) {
  const start = performance.now();
  let lastLog = 0;
  while (performance.now() - start < timeoutMs) {
    if (await fn()) return performance.now() - start;
    const elapsed = performance.now() - start;
    if (elapsed - lastLog > 15000) {
      lastLog = elapsed;
      console.log(`  ... still waiting (${Math.round(elapsed / 1000)}s, last error: ${lastHttpErr})`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout after ${timeoutMs}ms (last error: ${lastHttpErr})`);
}

let lastHttpErr = "";
async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) lastHttpErr = `HTTP ${res.status}`;
    return res.ok ? await res.text() : null;
  } catch (e) {
    lastHttpErr = e.cause?.code || e.cause?.message || e.message;
    return null;
  }
}

function duKb(dir) {
  try {
    return Number(execSync(`du -sk "${dir}"`, { encoding: "utf8" }).split(/\s+/)[0]);
  } catch {
    return 0;
  }
}

/** Package size as shipped: skip nested node_modules / examples / tests that
 *  exist only in monorepo checkouts. */
function pkgDuKb(dir) {
  let bytes = 0;
  const skip = new Set(["node_modules", "example", "test", "bench", ".git"]);
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return Math.round(bytes / 1024);
}

/** du of a package plus its transitive prod deps, resolved from `fromDir`. */
function closureDuKb(pkgName, fromDir) {
  const req = createRequire(path.join(fromDir, "noop.js"));
  const seen = new Set();
  const stack = [pkgName];
  let total = 0;
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    let pkgJsonPath;
    try {
      pkgJsonPath = req.resolve(`${name}/package.json`);
    } catch {
      try {
        // exports maps often hide package.json; walk from the entry instead
        const entry = req.resolve(name);
        let dir = path.dirname(entry);
        while (dir !== "/" && !fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
        pkgJsonPath = path.join(dir, "package.json");
      } catch {
        continue;
      }
    }
    const pkgDir = path.dirname(pkgJsonPath);
    total += pkgDuKb(pkgDir);
    try {
      const deps = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).dependencies || {};
      stack.push(...Object.keys(deps));
    } catch {}
  }
  return total;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
function p95(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
}

// --- edit target -----------------------------------------------------------

function findEditTarget(dir) {
  for (const candidate of ["app/index.tsx", "app/index.jsx", "App.tsx", "App.jsx", "index.tsx", "index.js"]) {
    const p = path.join(dir, candidate);
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No editable entry component found in " + dir);
}

// --- one server benchmark ----------------------------------------------------

async function benchServer({ name, cmd, cmdArgs, cwd, port, bundleUrl, statusUrl, readyTimeout }) {
  // Fail fast if the port is already taken by a stale process -- expo would
  // silently offer/choose another port and the probes would spin forever.
  if (await httpOk(statusUrl) !== null || await httpOk(`http://127.0.0.1:${port}/`) !== null) {
    throw new Error(`[${name}] port ${port} is already in use -- kill the stale process first`);
  }
  console.log(`\n[${name}] spawning: ${cmd} ${cmdArgs.join(" ")}`);
  // NOTE: no CI=1 -- Metro disables file watching in CI mode, which would
  // break the edit-storm measurement. Child output goes to a log file so the
  // pipe can never fill up and block the child.
  const logPath = path.join(process.env.TMPDIR || "/tmp", `bench-${name.replace(/\W+/g, "-")}.log`);
  const logFd = fs.openSync(logPath, "w");
  const child = spawn(cmd, cmdArgs, {
    cwd,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, EXPO_NO_TELEMETRY: "1", BROWSER: "none" },
    detached: true,
  });
  console.log(`[${name}] output: ${logPath}`);
  let peakRssKb = 0;
  const rssPoll = setInterval(() => {
    peakRssKb = Math.max(peakRssKb, treeRssKb(child.pid));
  }, 500);

  const result = { name };
  const editTarget = findEditTarget(cwd);
  const originalSource = fs.readFileSync(editTarget, "utf8");

  try {
    const spawnStart = performance.now();
    result.coldStartMs = Math.round(await waitFor(() => httpOk(statusUrl), readyTimeout));
    result.rssAtReadyKb = treeRssKb(child.pid);

    const bundleStart = performance.now();
    let firstBundle = null;
    await waitFor(async () => {
      firstBundle = await httpOk(bundleUrl);
      return firstBundle !== null && firstBundle.length > 1000;
    }, readyTimeout);
    result.firstBundleMs = Math.round(performance.now() - bundleStart);
    result.bundleBytes = firstBundle.length;
    result.rssAfterBundleKb = treeRssKb(child.pid);

    // Edit storm: append a marker console.log, wait until it is observable.
    const latencies = [];
    for (let i = 0; i < edits; i++) {
      const marker = `__bench_marker_${Date.now()}_${i}__`;
      fs.writeFileSync(editTarget, originalSource + `\nconsole.log("${marker}");\n`);
      const t = performance.now();
      await waitFor(async () => {
        const body = await httpOk(bundleUrl);
        return body !== null && body.includes(marker);
      }, 60_000, 60);
      latencies.push(performance.now() - t);
      process.stdout.write(`\r[${name}] edits: ${i + 1}/${edits}  last: ${Math.round(latencies.at(-1))}ms   `);
    }
    console.log("");
    result.rebuildMedianMs = Math.round(median(latencies));
    result.rebuildP95Ms = Math.round(p95(latencies));
    result.rssAfterEditsKb = treeRssKb(child.pid);
    result.peakRssKb = Math.max(peakRssKb, result.rssAfterEditsKb, result.rssAfterBundleKb);
    void spawnStart;
  } finally {
    clearInterval(rssPoll);
    fs.writeFileSync(editTarget, originalSource);
    try {
      process.kill(-child.pid, "SIGTERM"); // whole process group
    } catch {
      child.kill("SIGTERM");
    }
    await sleep(500);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  return result;
}

// --- main --------------------------------------------------------------------

const results = [];

results.push(
  await benchServer({
    name: "rnrun",
    cmd: process.execPath,
    cmdArgs: [RNRUN_BIN, "start", projectDir, "--port", String(RNRUN_PORT), "--host", "localhost", "--quiet"],
    cwd: projectDir,
    port: RNRUN_PORT,
    statusUrl: `http://127.0.0.1:${RNRUN_PORT}/status`,
    bundleUrl: `http://127.0.0.1:${RNRUN_PORT}/index.bundle?platform=web`,
    readyTimeout: 180_000,
  })
);
results[0].installKb = closureDuKb("rnrun", HERE) || duKb(path.join(HERE, ".."));

if (compare) {
  results.push(
    await benchServer({
      name: "expo start",
      cmd: "npx",
      cmdArgs: ["expo", "start", "--port", String(EXPO_PORT)],
      cwd: projectDir,
      port: EXPO_PORT,
      statusUrl: `http://127.0.0.1:${EXPO_PORT}/status`,
      // Metro serves bundles at <entry>.bundle relative to the project root;
      // for an expo-router app that's the expo-router entry, not /index.bundle.
      bundleUrl: `http://127.0.0.1:${EXPO_PORT}/node_modules/expo-router/entry.bundle?platform=web&dev=true&minify=false`,
      readyTimeout: 300_000,
    })
  );
  results[1].installKb = duKb(path.join(projectDir, "node_modules"));
}

// --- report ------------------------------------------------------------------

const mb = (kb) => (kb / 1024).toFixed(1) + " MB";
const rows = [
  ["cold start", (r) => r.coldStartMs + " ms"],
  ["first bundle", (r) => r.firstBundleMs + " ms"],
  ["bundle size", (r) => (r.bundleBytes / 1024).toFixed(0) + " KB"],
  [`rebuild median (${edits} edits)`, (r) => r.rebuildMedianMs + " ms"],
  ["rebuild p95", (r) => r.rebuildP95Ms + " ms"],
  ["RSS at ready", (r) => mb(r.rssAtReadyKb)],
  ["RSS after first bundle", (r) => mb(r.rssAfterBundleKb)],
  ["RSS after edit storm", (r) => mb(r.rssAfterEditsKb)],
  ["RSS peak", (r) => mb(r.peakRssKb)],
  ["install footprint", (r) => mb(r.installKb)],
];

const header = ["metric", ...results.map((r) => r.name)];
const table = [header, ...rows.map(([label, fmt]) => [label, ...results.map(fmt)])];
const widths = header.map((_, col) => Math.max(...table.map((row) => String(row[col]).length)));
const fmtRow = (row) => "| " + row.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";

console.log("\n" + fmtRow(table[0]));
console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
for (const row of table.slice(1)) console.log(fmtRow(row));
console.log("");

const rnrunSteady = results[0].rssAfterEditsKb / 1024;
if (rnrunSteady > 120) {
  console.warn(`WARNING: rnrun steady-state RSS ${rnrunSteady.toFixed(0)} MB exceeds the 120 MB target`);
} else {
  console.log(`rnrun steady-state RSS ${rnrunSteady.toFixed(0)} MB (target < 120 MB) -- OK`);
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ projectDir, edits, when: new Date().toISOString(), results }, null, 2));
  console.log(`JSON written to ${jsonOut}`);
}
