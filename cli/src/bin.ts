#!/usr/bin/env node
import { parseArgs, formatHelp, type FlagSpec } from "./args.js";
import { startCommand, DEFAULT_PACKAGE_SERVER } from "./commands/start.js";
import { bundleCommand } from "./commands/bundle.js";
import { cacheFillCommand } from "./commands/cache-fill.js";

const START_FLAGS: FlagSpec[] = [
  { name: "--port", type: "number", default: 8081, description: "Port to listen on (Metro's default)" },
  { name: "--package-server", type: "string", default: DEFAULT_PACKAGE_SERVER, description: "Pre-bundled package server URL" },
  { name: "--local-packages", type: "boolean", default: false, description: "Use/spawn a local reactnative-esm on :5200" },
  { name: "--host", type: "string", default: "lan", description: "Bind address: lan or localhost" },
  { name: "--quiet", type: "boolean", default: false, description: "Suppress non-error output" },
  {
    name: "--prewarm",
    type: "string",
    description: 'Build native bundles at startup instead of on first device request, e.g. "ios" or "ios,android" (env: RNRUN_PREWARM)',
  },
  {
    name: "--expo-go-anonymous",
    type: "boolean",
    default: false,
    description: "Serve an anonymous manifest so Expo Go on iOS skips the SDK 57 sign-in gate for remote/public URLs (trades away Fast Refresh) (env: RNRUN_EXPO_GO_ANONYMOUS)",
  },
];

const BUNDLE_FLAGS: FlagSpec[] = [
  { name: "--platform", type: "string", default: "web", description: "Target platform (web only for now)" },
  { name: "--out", type: "string", description: "Output directory (default: stdout)" },
  { name: "--package-server", type: "string", default: DEFAULT_PACKAGE_SERVER, description: "Pre-bundled package server URL" },
  { name: "--quiet", type: "boolean", default: false, description: "Suppress non-error output" },
];

const CACHE_FILL_FLAGS: FlagSpec[] = [
  { name: "--worklets", type: "string", description: 'Worklets babel plugin versions to store, e.g. "0.13.0,0.10.1"' },
  { name: "--prune-days", type: "number", description: "Remove entries older than this many days that stdin no longer lists" },
  { name: "--max-new", type: "number", description: "Store at most this many new entries per run (list the most wanted first)" },
];

const HELP = `rnrun -- a tiny drop-in replacement for the Expo dev server

Usage:
  rnrun start [dir] [options]    Start the dev server (default command)
  rnrun bundle [dir] [options]   One-shot bundle to stdout or --out
  rnrun cache-fill <dir> [opts]  Fill a host's shared read-only cache (RNRUN_SHARED_CACHE_DIR)
                                 with the package-server URLs read from stdin, one per line
  rnrun help                     Show this help

${formatHelp("start options:", START_FLAGS)}
${formatHelp("bundle options:", BUNDLE_FLAGS)}
${formatHelp("cache-fill options:", CACHE_FILL_FLAGS)}`;

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
      prewarm: (parsed.flags.prewarm as string | undefined) ?? process.env.RNRUN_PREWARM,
      expoGoAnonymous:
        (parsed.flags.expoGoAnonymous as boolean) ||
        process.env.RNRUN_EXPO_GO_ANONYMOUS === "1" ||
        process.env.RNRUN_EXPO_GO_ANONYMOUS === "true",
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

  if (command === "cache-fill") {
    const parsed = parseArgs(rest, CACHE_FILL_FLAGS);
    if (parsed.dir === ".") throw new Error("cache-fill needs the shared cache directory");
    await cacheFillCommand({
      dir: parsed.dir,
      worklets: ((parsed.flags.worklets as string | undefined) ?? "").split(",").map((v) => v.trim()).filter(Boolean),
      pruneDays: parsed.flags.pruneDays as number | undefined,
      maxNew: parsed.flags.maxNew as number | undefined,
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
