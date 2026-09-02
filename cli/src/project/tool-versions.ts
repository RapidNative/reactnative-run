import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

/**
 * Version of an installed package, found by walking up from its resolved
 * entry point. `require("<pkg>/package.json")` is NOT usable here: a package
 * with an `exports` map that doesn't list "./package.json" (browser-metro)
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED, which is how the bundle-cache key
 * silently degraded to "unknown" and kept serving bundles built by an older
 * rnrun after every upgrade.
 */
export function packageVersion(req: NodeJS.Require, name: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(req.resolve(name));
  } catch {
    return null;
  }
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === name && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not this directory */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** rnrun + browser-metro versions: the bundle format depends on both, so they
 *  belong in the bundle-cache key. "unknown" for a part that can't be resolved. */
export function toolVersions(): string {
  const req = createRequire(import.meta.url);
  let self = "unknown";
  try {
    self = (req("../../package.json") as { version: string }).version;
  } catch {
    /* unexpected layout */
  }
  return `rnrun@${self}+bm@${packageVersion(req, "browser-metro") ?? "unknown"}`;
}
