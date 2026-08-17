import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import qrcode from "qrcode-terminal";
import type { Logger } from "./logger.js";
import type { HmrHub } from "../server/hmr.js";

/**
 * expo-cli-parity terminal UI: the startup banner (QR code + waiting-on
 * lines) and the interactive keymap (a/i/w/j/r/m/o/?).
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function qrString(url: string): string {
  let out = "";
  qrcode.generate(url, { small: true }, (q: string) => {
    out = q;
  });
  return out;
}

export function printStartupBanner(opts: {
  rootDir: string;
  expUrl: string;
  webUrl: string;
  interactive: boolean;
}): void {
  const p = (s = "") => console.log(s);
  p(`Starting project at ${opts.rootDir}`);
  p(qrString(opts.expUrl));
  p(`${DIM}›${RESET} Metro waiting on ${BOLD}${opts.expUrl}${RESET}`);
  p(`${DIM}›${RESET} Scan the QR code above with Expo Go (Android) or the Camera app (iOS)`);
  p();
  p(`${DIM}›${RESET} Web is waiting on ${BOLD}${opts.webUrl}${RESET}`);
  p();
  p(`${DIM}›${RESET} Using ${BOLD}Expo Go${RESET}`);
  if (opts.interactive) {
    p(`${DIM}›${RESET} Press ${BOLD}a${RESET} ${DIM}│${RESET} open Android`);
    p(`${DIM}›${RESET} Press ${BOLD}i${RESET} ${DIM}│${RESET} open iOS simulator`);
    p(`${DIM}›${RESET} Press ${BOLD}w${RESET} ${DIM}│${RESET} open web`);
    p();
    p(`${DIM}›${RESET} Press ${BOLD}r${RESET} ${DIM}│${RESET} reload app`);
    p(`${DIM}›${RESET} Press ${BOLD}m${RESET} ${DIM}│${RESET} toggle menu`);
    p();
    p(`${DIM}›${RESET} Press ${BOLD}?${RESET} ${DIM}│${RESET} show all commands`);
  }
  p();
  p(`${DIM}Logs for your project will appear below. Press Ctrl+C to exit.${RESET}`);
}

function printAllCommands(): void {
  const p = (s = "") => console.log(s);
  p();
  p(`${DIM}›${RESET} Press ${BOLD}a${RESET} ${DIM}│${RESET} open Android`);
  p(`${DIM}›${RESET} Press ${BOLD}i${RESET} ${DIM}│${RESET} open iOS simulator`);
  p(`${DIM}›${RESET} Press ${BOLD}w${RESET} ${DIM}│${RESET} open web`);
  p(`${DIM}›${RESET} Press ${BOLD}r${RESET} ${DIM}│${RESET} reload app`);
  p(`${DIM}›${RESET} Press ${BOLD}m${RESET} ${DIM}│${RESET} toggle menu`);
  p(`${DIM}›${RESET} Press ${BOLD}o${RESET} ${DIM}│${RESET} open project code in your editor`);
  p(`${DIM}›${RESET} Press ${BOLD}q${RESET} ${DIM}│${RESET} quit`);
  p();
}

/** Boot a simulator if needed, ensure Expo Go, open the exp:// URL. */
async function openIosSimulator(port: number, log: Logger): Promise<void> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cmd, args, { timeout: 60_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
    );
  try {
    let booted = "";
    try {
      booted = await run("xcrun", ["simctl", "list", "devices", "booted"]);
    } catch {
      log.error("xcrun not available -- is Xcode installed?");
      return;
    }
    if (!/Booted/.test(booted)) {
      const avail = await run("xcrun", ["simctl", "list", "devices", "available"]);
      const m = avail.match(/iPhone[^(]*\(([0-9A-F-]{36})\)/);
      if (!m) {
        log.error("No available iPhone simulator found.");
        return;
      }
      log.info("Booting iOS simulator ...");
      await run("xcrun", ["simctl", "boot", m[1]]).catch(() => {});
      await run("open", ["-a", "Simulator"]);
      await new Promise((r) => setTimeout(r, 6000));
    } else {
      await run("open", ["-a", "Simulator"]).catch(() => {});
    }
    // Expo Go present? Install the newest cached build if not.
    const apps = await run("xcrun", ["simctl", "listapps", "booted"]).catch(() => "");
    if (!apps.includes("host.exp.Exponent")) {
      const cacheDir = path.join(os.homedir(), ".expo", "ios-simulator-app-cache");
      const cached = fs.existsSync(cacheDir)
        ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".app")).sort().pop()
        : undefined;
      if (cached) {
        log.info(`Installing Expo Go (${cached}) on the simulator ...`);
        await run("xcrun", ["simctl", "install", "booted", path.join(cacheDir, cached)]);
      } else {
        log.error("Expo Go is not installed on the simulator and no cached build was found in ~/.expo. Install it once with `npx expo start` + i, or from the App Store in the simulator.");
        return;
      }
    }
    await run("xcrun", ["simctl", "openurl", "booted", `exp://127.0.0.1:${port}`]);
    log.info("Opening exp://127.0.0.1:" + port + " in Expo Go (iOS simulator)");
  } catch (err) {
    log.error(`iOS simulator open failed: ${(err as Error).message}`);
  }
}

/** adb reverse + open Expo Go on a connected Android device/emulator. */
async function openAndroid(port: number, expUrl: string, log: Logger): Promise<void> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cmd, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
    );
  try {
    const devices = await run("adb", ["devices"]).catch(() => null);
    if (devices === null) {
      log.error("adb not found -- install Android platform-tools to open Android.");
      return;
    }
    if (!/^\S+\tdevice$/m.test(devices)) {
      log.error("No Android device/emulator connected (adb devices is empty).");
      return;
    }
    // localhost forwarding so the device reaches this machine regardless of LAN.
    await run("adb", ["reverse", `tcp:${port}`, `tcp:${port}`]).catch(() => {});
    await run("adb", [
      "shell", "am", "start",
      "-a", "android.intent.action.VIEW",
      "-d", `exp://127.0.0.1:${port}`,
    ]);
    log.info(`Opening exp://127.0.0.1:${port} in Expo Go (Android)`);
  } catch (err) {
    log.error(`Android open failed: ${(err as Error).message} -- scan the QR (${expUrl}) instead.`);
  }
}

function openWeb(webUrl: string, log: Logger): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execFileSync(opener, [webUrl], { stdio: "ignore" });
    log.info(`Opening ${webUrl}`);
  } catch {
    log.info(`Open ${webUrl} in your browser.`);
  }
}

function openEditor(rootDir: string, log: Logger): void {
  for (const editor of [process.env.EXPO_EDITOR, process.env.EDITOR, "code"]) {
    if (!editor) continue;
    try {
      execFileSync(editor, [rootDir], { stdio: "ignore" });
      log.info(`Opened ${rootDir} in ${editor}`);
      return;
    } catch {
      /* try next */
    }
  }
  log.error("No editor found (set $EDITOR or install the `code` command).");
}

export function attachInteractiveKeys(opts: {
  rootDir: string;
  port: number;
  expUrl: string;
  webUrl: string;
  hub: HmrHub;
  log: Logger;
  shutdown: () => void;
}): void {
  const { log } = opts;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    switch (key) {
      case "a":
        void openAndroid(opts.port, opts.expUrl, log);
        break;
      case "i":
        void openIosSimulator(opts.port, log);
        break;
      case "w":
        openWeb(opts.webUrl, log);
        break;
      case "r":
        opts.hub.reloadAll();
        log.info("Reloaded all clients");
        break;
      case "m":
        opts.hub.devMenuAll();
        log.info("Toggled developer menu");
        break;
      case "o":
        openEditor(opts.rootDir, log);
        break;
      case "?":
        printAllCommands();
        break;
      case "q":
      case "\u0003": // Ctrl+C
        opts.shutdown();
        break;
    }
  });
}
