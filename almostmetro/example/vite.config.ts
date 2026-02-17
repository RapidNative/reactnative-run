import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import esbuild from "esbuild";

const CACHE_DIR = path.join(__dirname, ".pkg-cache");

function parseSpecifier(raw: string) {
  let pkgName: string;
  let version: string;
  let subpath: string = "";

  if (raw.startsWith("@")) {
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

  const atIdx = pkgName.lastIndexOf("@");
  if (atIdx > 0) {
    version = pkgName.slice(atIdx + 1);
    pkgName = pkgName.slice(0, atIdx);
  } else {
    version = "latest";
  }

  return { pkgName, version, subpath };
}

async function bundlePkg(pkgName: string, version: string, subpath: string): Promise<string> {
  const requireSpecifier = pkgName + subpath;
  const cacheKey = `${pkgName}@${version}${subpath.replace(/\//g, "__")}`;
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.js`);

  if (fs.existsSync(cacheFile)) {
    console.log(`[pkg cache hit] ${requireSpecifier}@${version}`);
    return fs.readFileSync(cacheFile, "utf-8");
  }

  console.log(`[pkg bundling] ${requireSpecifier}@${version}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));

  try {
    execSync("npm init -y", { cwd: tmpDir, stdio: "ignore" });
    execSync(`npm install ${pkgName}@${version}`, {
      cwd: tmpDir,
      stdio: "ignore",
      timeout: 60000,
    });

    const installedPkgJson = path.join(tmpDir, "node_modules", pkgName, "package.json");
    let peerDeps: string[] = [];
    if (fs.existsSync(installedPkgJson)) {
      const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
      peerDeps = Object.keys(meta.peerDependencies || {});
    }

    const entryFile = path.join(tmpDir, "__entry.js");
    fs.writeFileSync(entryFile, `module.exports = require("${requireSpecifier}");\n`);

    const outFile = path.join(tmpDir, "__out.js");
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: "iife",
      globalName: "__module",
      outfile: outFile,
      platform: "browser",
      target: "es2020",
      external: peerDeps,
    });

    const bundled = fs.readFileSync(outFile, "utf-8");
    const wrapped = `// Bundled: ${requireSpecifier}@${version}\n// Peers: ${peerDeps.join(", ") || "none"}\n${bundled}\nmodule.exports = typeof __module !== "undefined" ? (__module.default || __module) : {};\n`;

    fs.writeFileSync(cacheFile, wrapped);
    console.log(`[pkg cached] ${requireSpecifier}@${version}`);
    return wrapped;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function packageServerPlugin(): Plugin {
  return {
    name: "package-server",
    configureServer(server) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });

      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" || !req.url?.startsWith("/pkg/")) {
          next();
          return;
        }

        const raw = decodeURIComponent(req.url.slice("/pkg/".length));
        if (!raw) { next(); return; }

        const parsed = parseSpecifier(raw);
        if (!parsed) {
          res.statusCode = 400;
          res.end("// Invalid package specifier\n");
          return;
        }

        bundlePkg(parsed.pkgName, parsed.version, parsed.subpath)
          .then((code) => {
            res.setHeader("Content-Type", "application/javascript");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.end(code);
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[pkg error] ${raw}:`, message);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end(`// Error bundling ${raw}\n// ${message}\n`);
            }
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), packageServerPlugin()],
  server: {
    allowedHosts: true,
  },
});
