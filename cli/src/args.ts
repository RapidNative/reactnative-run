export interface FlagSpec {
  /** e.g. "--port" */
  name: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  description: string;
}

export interface ParsedArgs {
  command: string;
  /** First non-flag positional after the command (project dir). */
  dir: string;
  flags: Record<string, string | number | boolean>;
}

/**
 * Declarative flag parser. Positional args and flags can appear in any order
 * (unlike the lifo prototype, where `browser-metro --port 8082` silently
 * ignored the flag unless the dir came first).
 */
export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const flags: Record<string, string | number | boolean> = {};
  for (const s of specs) if (s.default !== undefined) flags[key(s.name)] = s.default;

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const spec = byName.get(name);
    if (!spec) throw new Error(`Unknown flag: ${name}`);
    if (spec.type === "boolean") {
      flags[key(name)] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      continue;
    }
    const raw = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    if (raw === undefined) throw new Error(`Flag ${name} requires a value`);
    flags[key(name)] = spec.type === "number" ? assertNumber(name, raw) : raw;
  }

  return {
    command: positionals[0] || "",
    dir: positionals[1] || ".",
    flags,
  };
}

function assertNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Flag ${name} expects a number, got "${raw}"`);
  return n;
}

/** "--package-server" -> "packageServer" */
function key(name: string): string {
  return name
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function formatHelp(usage: string, specs: FlagSpec[]): string {
  const lines = specs.map((s) => {
    const def = s.default !== undefined ? ` (default: ${s.default})` : "";
    return `  ${s.name.padEnd(22)} ${s.description}${def}`;
  });
  return `${usage}\n\nOptions:\n${lines.join("\n")}\n`;
}
