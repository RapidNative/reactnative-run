#!/usr/bin/env node
import { parseArgs, formatHelp, type FlagSpec } from "./args.js";
import { startCommand, DEFAULT_PACKAGE_SERVER } from "./commands/start.js";
import { bundleCommand } from "./commands/bundle.js";

const START_FLAGS: FlagSpec[] = [
  { name: "--port", type: "number", default: 8081, description: "Port to listen on (Metro's default)" },
  { name: "--package-server", type: "string", default: DEFAULT_PACKAGE_SERVER, description: "Pre-bundled package server URL" },
  { name: "--local-packages", type: "boolean", default: false, description: "Use/spawn a local reactnative-esm on :5200" },
  { name: "--host", type: "string", default: "lan", description: "Bind address: lan or localhost" },
  { name: "--quiet", type: "boolean", default: false, description: "Suppress non-error output" },
];

const BUNDLE_FLAGS: FlagSpec[] = [
  { name: "--platform", type: "string", default: "web", description: "Target platform (web only for now)" },
  { name: "--out", type: "string", description: "Output directory (default: stdout)" },
  { name: "--package-server", type: "string", default: DEFAULT_PACKAGE_SERVER, description: "Pre-bundled package server URL" },
  { name: "--quiet", type: "boolean", default: false, description: "Suppress non-error output" },
];

const HELP = `rnrun -- a tiny drop-in replacement for the Expo dev server

Usage:
  rnrun start [dir] [options]    Start the dev server (default command)
  rnrun bundle [dir] [options]   One-shot bundle to stdout or --out
  rnrun help                     Show this help

${formatHelp("start options:", START_FLAGS)}
${formatHelp("bundle options:", BUNDLE_FLAGS)}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "start";
  const rest = argv[0] && !argv[0].startsWith("--") ? argv : ["start", ...argv];

  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  if (command === "start") {
    const parsed = parseArgs(rest, START_FLAGS);
    await startCommand({
      dir: parsed.dir,
      port: parsed.flags.port as number,
      packageServer: parsed.flags.packageServer as string,
      localPackages: parsed.flags.localPackages as boolean,
      host: parsed.flags.host as string,
      quiet: parsed.flags.quiet as boolean,
    });
    return;
  }

  if (command === "bundle") {
    const parsed = parseArgs(rest, BUNDLE_FLAGS);
    await bundleCommand({
      dir: parsed.dir,
      platform: parsed.flags.platform as string,
      out: (parsed.flags.out as string) || null,
      packageServer: parsed.flags.packageServer as string,
      quiet: parsed.flags.quiet as boolean,
    });
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
