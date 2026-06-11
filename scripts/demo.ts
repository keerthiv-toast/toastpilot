/**
 * One-command hackathon demo:
 *   npm run demo
 *
 * - Validates .env + toolchain
 * - Boots iOS Simulator (best effort)
 * - Starts Appium if not already running
 * - Starts agent server + dashboard
 * - Opens the dashboard in your default browser
 */
import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPIUM_PORT = process.env.APPIUM_PORT ?? "4723";
const SERVER_PORT = process.env.AGENT_SERVER_PORT ?? "9477";
const DASHBOARD_PORT = process.env.AGENT_DASHBOARD_PORT ?? "5177";
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

let appiumChild: ChildProcess | null = null;
let startedAppium = false;

function log(msg: string): void {
  console.log(`\n▶ ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function runSync(cmd: string, opts?: { cwd?: string; ignoreError?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    if (opts?.ignoreError) return "";
    throw e;
  }
}

function ensureDependencies(): void {
  if (!existsSync(join(ROOT, "node_modules"))) {
    log("Installing dependencies (first run)…");
    execSync("npm install", { cwd: ROOT, stdio: "inherit" });
  }
}

function checkPrereqs(): void {
  log("Checking prerequisites…");

  if (!existsSync(join(ROOT, ".env"))) {
    console.log("  ℹ No .env file — using built-in test credentials + defaults");
  }

  try {
    runSync("xcodebuild -version");
  } catch {
    fail("Xcode command-line tools not found. Install Xcode.");
  }

  try {
    runSync("xcrun simctl list devices available", { ignoreError: false });
  } catch {
    fail("iOS Simulator (simctl) not available.");
  }

  console.log("  ✓ Node, Xcode, Simulator (credentials loaded from .env)");
}

function bootSimulator(): void {
  log("Booting iOS Simulator (best effort)…");
  try {
    execSync("npx tsx scripts/boot-simulator.ts", {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    console.warn("  ⚠ Simulator boot skipped — open Simulator manually if needed.");
  }
}

async function isAppiumUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${APPIUM_PORT}/status`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureAppium(): Promise<void> {
  if (await isAppiumUp()) {
    console.log(`  ✓ Appium already running on :${APPIUM_PORT}`);
    return;
  }

  log(`Starting Appium on port ${APPIUM_PORT}…`);
  appiumChild = spawn("npx", ["appium", "--port", APPIUM_PORT], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  startedAppium = true;

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isAppiumUp()) {
      console.log("  ✓ Appium ready");
      return;
    }
  }
  fail(`Appium did not start on port ${APPIUM_PORT} within 30s`);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return false;
}

function openBrowser(url: string): void {
  log(`Opening dashboard: ${url}`);
  try {
    if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: "cmd.exe" });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
  } catch {
    console.warn(`  ⚠ Could not open browser automatically. Visit ${url}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanup(): void {
  if (startedAppium && appiumChild?.pid) {
    console.log("\n▶ Stopping Appium…");
    try {
      process.kill(appiumChild.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ToastUnifiedInventory — AI QA Agent (Demo)                  ║
╚══════════════════════════════════════════════════════════════╝
`);

  ensureDependencies();
  checkPrereqs();
  bootSimulator();
  await ensureAppium();

  log("Building Toast Operator app if needed…");
  execSync("npm run app:build", { cwd: ROOT, stdio: "inherit" });

  log("Starting agent server + dashboard…");
  const dev = spawn(
    "npx",
    [
      "concurrently",
      "-n",
      "server,dashboard",
      "-c",
      "cyan,magenta",
      "npm run dev:server",
      "npm run dev:dashboard",
    ],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );

  // Give vite a moment, then open browser once dashboard responds.
  setTimeout(async () => {
    const ok = await waitForHttp(DASHBOARD_URL, 90_000);
    if (ok) {
      openBrowser(DASHBOARD_URL);
      console.log(`
Ready.
  Dashboard:  ${DASHBOARD_URL}
  API:        http://localhost:${SERVER_PORT}/api/health
  Appium:     http://127.0.0.1:${APPIUM_PORT}

Try: "cycle count full regression" (voice or Run Agent)
Press Ctrl+C to stop.
`);
    } else {
      console.warn(`\n⚠ Dashboard not reachable at ${DASHBOARD_URL} yet — open it manually.`);
    }
  }, 2000);

  dev.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
