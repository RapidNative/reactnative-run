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
  const cacheKey = `${pkgName.replace(/\//g, "__")}@${version}${subpath.replace(/\//g, "__")}`;
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

    // Read package metadata for peer deps and to detect RN/Expo packages.
    const installedPkgJson = path.join(tmpDir, "node_modules", pkgName, "package.json");
    let peerDeps: string[] = [];
    let isReactNative = false;
    let keywords: string[] = [];
    if (fs.existsSync(installedPkgJson)) {
      const meta = JSON.parse(fs.readFileSync(installedPkgJson, "utf-8"));
      peerDeps = Object.keys(meta.peerDependencies || {});
      keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
      isReactNative =
        pkgName.startsWith("@expo/") ||
        pkgName.includes("react-native") ||
        keywords.some((k: string) => k === "react-native" || k === "expo");
    }

    if (isReactNative) {
      // Always externalize react-native for RN/Expo packages -- the runtime
      // resolves it to react-native-web. Many packages use it without listing
      // it as a peer dep.
      for (const dep of ["react-native", "react", "react-dom"]) {
        if (!peerDeps.includes(dep)) peerDeps.push(dep);
      }
    }

    // Externalize @react-navigation/core so all packages share the same
    // ThemeContext (and other React contexts) at runtime.
    // Don't externalize a package from itself (would create circular require).
    if (requireSpecifier !== "@react-navigation/core" && !peerDeps.includes("@react-navigation/core")) {
      peerDeps.push("@react-navigation/core");
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
      // For RN/Expo packages: prioritize .web.* extensions, handle JSX in .js,
      // and inline font/image assets as data URLs.
      ...(isReactNative && {
        resolveExtensions: [
          ".web.tsx", ".web.ts", ".web.js",
          ".tsx", ".ts", ".js", ".json",
        ],
        loader: {
          ".js": "jsx",
          ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl",
        },
        banner: {
          js: "var process = { env: { NODE_ENV: 'production' } }; var React = require('react');",
        },
        define: {
          "__DEV__": "false",
        },
      }),
      // Keep peer deps as require() calls so the runtime resolves them
      // to the same shared instance (e.g. react-dom shares the react instance)
      external: peerDeps,
    });

    const bundled = fs.readFileSync(outFile, "utf-8");
    const wrapped = `// Bundled: ${requireSpecifier}@${version}\n// Peers: ${peerDeps.join(", ") || "none"}\n${bundled}\nif (typeof __module !== "undefined") { if (__module.default != null && typeof __module.default !== "object") { module.exports = __module.default; Object.keys(__module).forEach(function(k) { if (k !== "default") module.exports[k] = __module[k]; }); } else { module.exports = Object.assign({}, __module.default, __module); delete module.exports.default; } }\n`;

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
