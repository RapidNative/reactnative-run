import express from "express";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// --- CLI args ---
const bundlePath = path.resolve(process.argv[2] || "./bundle.expo.js");
const PORT = 8081;

// --- Read bundle into memory & watch for changes ---
let bundleCode = "";

function loadBundle() {
  try {
    bundleCode = fs.readFileSync(bundlePath, "utf-8");
    console.log(`Bundle loaded (${(bundleCode.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`Could not read bundle at ${bundlePath}`);
    process.exit(1);
  }
}

loadBundle();

fs.watchFile(bundlePath, { interval: 500 }, () => {
  console.log("Bundle changed on disk, reloading...");
  try {
    bundleCode = fs.readFileSync(bundlePath, "utf-8");
    console.log(
      `Bundle reloaded (${(bundleCode.length / 1024).toFixed(1)} KB)`
    );
  } catch {
    console.error("Failed to reload bundle");
  }
});

// --- Local IP ---
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const LOCAL_IP = getLocalIP();

// --- Express app ---
const app = express();

// GET / -- manifest or status page
app.get("/", (req, res) => {
  const platform = req.headers["expo-platform"];

  if (platform) {
    // Serve Expo Updates multipart manifest
    const bundleUrl = `http://${LOCAL_IP}:${PORT}/bundle.js`;

    const manifest = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      runtimeVersion: "exposdk:54.0.0",
      launchAsset: {
        key: "bundle",
        contentType: "application/javascript",
        url: bundleUrl,
      },
      assets: [],
      metadata: {},
      extra: {
        expoClient: {
          name: "expo-dev-server",
          slug: "expo-dev-server",
          version: "1.0.0",
          sdkVersion: "54.0.0",
          platforms: ["ios", "android"],
        },
        expoGo: {
          debuggerHost: `${LOCAL_IP}:${PORT}`,
          developer: { tool: "expo-cli" },
          mainModuleName: "index",
          packagerOpts: { dev: true },
        },
        scopeKey: "@anonymous/expo-dev-server",
      },
    };

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("expo-protocol-version", "0");
    res.setHeader("expo-sfv-version", "0");
    res.setHeader("cache-control", "private, max-age=0");
    res.send(JSON.stringify(manifest));
  } else {
    // Status page for browsers
    res.setHeader("Content-Type", "text/html");
    res.send(`
      <html>
        <head><title>Expo Dev Server</title></head>
        <body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px;">
          <h1>Expo Dev Server</h1>
          <p>Serving <code>${path.basename(bundlePath)}</code> (${(bundleCode.length / 1024).toFixed(1)} KB)</p>
          <p>Open in Expo Go: <code>exp://${LOCAL_IP}:${PORT}</code></p>
          <h3>Endpoints</h3>
          <ul>
            <li><code>GET /</code> &mdash; Manifest (with <code>expo-platform</code> header) or this page</li>
            <li><code>GET /bundle.js</code> &mdash; JS bundle</li>
          </ul>
        </body>
      </html>
    `);
  }
});

// GET /bundle.js -- serve the JS bundle
app.get("/bundle.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.send(bundleCode);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`\nExpo Dev Server running\n`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${LOCAL_IP}:${PORT}`);
  console.log(`  Expo Go:  exp://${LOCAL_IP}:${PORT}\n`);
  console.log(`Serving: ${bundlePath}\n`);
});
