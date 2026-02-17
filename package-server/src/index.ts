import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import esbuild from "esbuild";

const app = express();
const CACHE_DIR = path.join(__dirname, "..", "cache");
const PORT = 3001;

// Ensure cache dir exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

// CORS for browser access
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// Parse unpkg-style specifier into { pkgName, version, subpath }
function parseSpecifier(raw: string) {
  let pkgName: string;
  let version: string;
  let subpath: string = "";

  if (raw.startsWith("@")) {
    // Scoped: @scope/name@ver/sub
    const slashIdx = raw.indexOf("/");
    if (slashIdx === -1) return null;
    const secondSlash = raw.indexOf("/", slashIdx + 1);
    if (secondSlash === -1) {
      pkgName = raw;
    } else {
      pkgName = raw.slice(0, secondSlash);
      subpath = raw.slice(secondSlash);
    }
  } else {
    const slashIdx = raw.indexOf("/");
    if (slashIdx === -1) {
      pkgName = raw;
    } else {
      pkgName = raw.slice(0, slashIdx);
      subpath = raw.slice(slashIdx);
    }
  }

  // Extract version from pkgName
  const atIdx = pkgName.lastIndexOf("@");
  if (atIdx > 0) {
    version = pkgName.slice(atIdx + 1);
    pkgName = pkgName.slice(0, atIdx);
  } else {
    version = "latest";
  }

  return { pkgName, version, subpath };
}

// Bundle and serve an npm package
async function handlePkgRequest(res: Response, pkgName: string, version: string, subpath: string) {
  const requireSpecifier = pkgName + subpath;
  const cacheKey = `${pkgName}@${version}${subpath.replace(/\//g, "__")}`;
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.js`);

  // Check disk cache
  if (fs.existsSync(cacheFile)) {
    console.log(`[cache hit] ${requireSpecifier}@${version}`);
    res.type("application/javascript").sendFile(cacheFile);
    return;
  }

  console.log(`[bundling] ${requireSpecifier}@${version}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));

  try {
    execSync("npm init -y", { cwd: tmpDir, stdio: "ignore" });
    execSync(`npm install ${pkgName}@${version}`, {
      cwd: tmpDir,
      stdio: "ignore",
      timeout: 60000,
    });

    // Read peer dependencies so we can mark them as external.
    // This prevents duplicate copies (e.g. react-dom bundling its own react).
    const installedPkgJson = path.join(tmpDir, "node_modules", pkgName, "package.json");
    let peerDeps: string[] = [];
    if (fs.existsSync(installedPkgJson)) {
      const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
      peerDeps = Object.keys(meta.peerDependencies || {});
    }

    const entryFile = path.join(tmpDir, "__entry.js");
    fs.writeFileSync(
      entryFile,
      `module.exports = require("${requireSpecifier}");\n`
    );

    const outFile = path.join(tmpDir, "__out.js");
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: "iife",
      globalName: "__module",
      outfile: outFile,
      platform: "browser",
      target: "es2020",
      // Keep peer deps as require() calls so the runtime resolves them
      // to the same shared instance (e.g. react-dom shares the react instance)
      external: peerDeps,
    });

    const bundled = fs.readFileSync(outFile, "utf-8");
    const wrapped = `// Bundled: ${requireSpecifier}@${version}\n// Peers: ${peerDeps.join(", ") || "none"}\n${bundled}\nmodule.exports = typeof __module !== "undefined" ? (__module.default || __module) : {};\n`;

    fs.writeFileSync(cacheFile, wrapped);
    console.log(`[cached] ${requireSpecifier}@${version}`);

    res.type("application/javascript").send(wrapped);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] ${requireSpecifier}@${version}:`, message);
    res.status(500).send(`// Error bundling ${requireSpecifier}@${version}\n// ${message}\n`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// GET /pkg/* - unpkg-style URLs:
//   /pkg/lodash           -> lodash@latest
//   /pkg/lodash@4.17.21   -> lodash@4.17.21
//   /pkg/react-dom/client -> react-dom@latest, require("react-dom/client")
//   /pkg/react-dom@19/client -> react-dom@19, require("react-dom/client")
//   /pkg/@scope/name@1.0/sub -> @scope/name@1.0, require("@scope/name/sub")
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET" || !req.path.startsWith("/pkg/")) { next(); return; }
  const raw = decodeURIComponent(req.path.slice("/pkg/".length));
  if (!raw) { next(); return; }

  const parsed = parseSpecifier(raw);
  if (!parsed) { res.status(400).send("// Invalid package specifier\n"); return; }

  handlePkgRequest(res, parsed.pkgName, parsed.version, parsed.subpath).catch(
    (err) => {
      console.error("[unhandled]", err);
      if (!res.headersSent) res.status(500).send("// Internal error\n");
    }
  );
});

app.listen(PORT, () => {
  console.log(`Package server running at http://localhost:${PORT}`);
});
