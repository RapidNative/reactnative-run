import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface ExpoAppConfig {
  name?: string;
  slug?: string;
  scheme?: string;
  sdkVersion?: string;
  [key: string]: unknown;
}

export interface ProjectConfig {
  /** The `expo` object from app.json / app.config.js (empty when absent). */
  app: ExpoAppConfig;
  /** EXPO_PUBLIC_* / NEXT_PUBLIC_* vars from process.env and .env files. */
  env: Record<string, string>;
  /** package.json contents (parsed), or {}. */
  pkg: Record<string, unknown>;
}

const PUBLIC_PREFIXES = ["EXPO_PUBLIC_", "NEXT_PUBLIC_"];

/** Parse a .env file body. Tiny on purpose -- no dotenv dependency. */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Load app config. Precedence mirrors expo: app.config.js (evaluated, may
 * crash -- fall back with a warning) over app.json. app.config.ts is not
 * supported yet and reported as such.
 */
export async function loadAppConfig(
  rootDir: string,
  warn: (msg: string) => void
): Promise<ExpoAppConfig> {
  const appJsonPath = path.join(rootDir, "app.json");
  const appJson = fs.existsSync(appJsonPath) ? readJson(appJsonPath) : {};
  const base = (appJson.expo as ExpoAppConfig) || (appJson as ExpoAppConfig) || {};

  const tsConfig = path.join(rootDir, "app.config.ts");
  if (fs.existsSync(tsConfig)) {
    warn("app.config.ts is not supported yet; using app.json values only.");
  }

  const jsConfig = path.join(rootDir, "app.config.js");
  if (fs.existsSync(jsConfig)) {
    try {
      const mod = await import(pathToFileURL(jsConfig).href);
      const exported = mod.default ?? mod;
      const result = typeof exported === "function" ? exported({ config: base }) : exported;
      const expo = (result?.expo as ExpoAppConfig) ?? (result as ExpoAppConfig);
      if (expo && typeof expo === "object") return expo;
    } catch (err) {
      warn(`Failed to evaluate app.config.js (${(err as Error).message}); falling back to app.json.`);
    }
  }

  return base;
}

export async function loadProjectConfig(
  rootDir: string,
  warn: (msg: string) => void
): Promise<ProjectConfig> {
  const env: Record<string, string> = {};
  const addPublic = (source: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined && PUBLIC_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
    }
  };
  // .env then .env.local (later wins), then process.env (highest precedence).
  for (const name of [".env", ".env.local"]) {
    const file = path.join(rootDir, name);
    if (fs.existsSync(file)) addPublic(parseEnvFile(fs.readFileSync(file, "utf8")));
  }
  addPublic(process.env);

  return {
    app: await loadAppConfig(rootDir, warn),
    env,
    pkg: readJson(path.join(rootDir, "package.json")),
  };
}
