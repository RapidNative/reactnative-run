import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { bundleCacheDir } from "../bundler/bundle-cache.js";

// The native platforms a device has asked this project for, kept beside the
// bundle cache so it lives as long as the cache does (a hosted preview puts
// that on its persistent /data). `--prewarm android:seen` reads it: a project
// only ever scanned on an iPhone shouldn't build and hold an Android session
// on every wake.

function historyPath(rootDir: string): string {
  // The default cache dir is shared by every project on a machine.
  const id = createHash("sha256").update(path.resolve(rootDir)).digest("hex").slice(0, 16);
  return path.join(bundleCacheDir(), `platforms-${id}.json`);
}

export function seenPlatforms(rootDir: string): Set<string> {
  try {
    const list = JSON.parse(fs.readFileSync(historyPath(rootDir), "utf8")) as unknown;
    return new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/** Adds `platform` to the project's history (and to `seen`); writes only when it is new. */
export function rememberPlatform(rootDir: string, seen: Set<string>, platform: string): void {
  if (seen.has(platform)) return;
  seen.add(platform);
  try {
    const file = historyPath(rootDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...seen].sort()));
    fs.renameSync(tmp, file);
  } catch {
    /* best effort: the next request tries again only after a restart */
  }
}

/**
 * Parses --prewarm ("ios,android:seen,web") into the native platforms to build
 * now. A `:seen` platform is built only if a device has asked for it before.
 * `named` lists every native platform mentioned, built or not.
 */
export function prewarmPlan(raw: string | undefined, seen: Set<string>): { build: string[]; skipped: string[]; named: string[]; web: boolean } {
  const plan = { build: [] as string[], skipped: [] as string[], named: [] as string[], web: false };
  for (const token of (raw ?? "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    const [platform, condition] = token.split(":");
    if (platform === "web") {
      plan.web = true;
      continue;
    }
    if (platform !== "ios" && platform !== "android") continue;
    if (condition !== undefined && condition !== "seen") continue;
    if (plan.named.includes(platform)) continue;
    plan.named.push(platform);
    if (condition === "seen" && !seen.has(platform)) plan.skipped.push(platform);
    else plan.build.push(platform);
  }
  return plan;
}
