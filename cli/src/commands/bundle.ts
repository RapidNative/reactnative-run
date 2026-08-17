import * as fs from "node:fs";
import * as path from "node:path";
import { scanProject } from "../project/scan.js";
import { loadProjectConfig } from "../project/config.js";
import { BundlerSession } from "../bundler/session.js";
import { createLogger } from "../ui/logger.js";

export interface BundleOptions {
  dir: string;
  platform: string;
  out: string | null;
  packageServer: string;
  quiet: boolean;
}

/** One-shot export: bundle to stdout or --out <dir>. Web only for now. */
export async function bundleCommand(options: BundleOptions): Promise<void> {
  const log = createLogger(options.quiet || !options.out);
  if (options.platform !== "web") {
    throw new Error(`Platform "${options.platform}" is not supported yet (web only).`);
  }
  const rootDir = path.resolve(options.dir);
  const config = await loadProjectConfig(rootDir, log.warn);
  const { files } = scanProject(rootDir);

  const session = new BundlerSession(files, {
    packageServerUrl: options.packageServer,
    env: config.env,
    platform: "web",
    assetPublicPath: "/__bm_assets",
  });

  const ok = await session.build();
  if (!ok) {
    throw new Error(`Bundle failed:\n${session.buildError}`);
  }

  if (options.out) {
    const outDir = path.resolve(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.bundle.js"), session.getBundle());
    log.info(`Wrote ${path.join(outDir, "index.bundle.js")} (${(session.getBundle().length / 1024).toFixed(0)} KB)`);
  } else {
    process.stdout.write(session.getBundle());
  }
}
