import { execFileSync, spawn, type ChildProcess } from "child_process";
import { createConnection } from "net";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import colors from "@colors/colors";

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTOMATION_ROOT = join(AGENT_ROOT, "../automation");

export const APPIUM_HOST = process.env.APPIUM_HOST ?? "127.0.0.1";
export const APPIUM_PORT = parseInt(process.env.APPIUM_PORT ?? "4723", 10);

let managedProcess: ChildProcess | null = null;
let starting: Promise<void> | null = null;
const recentLogs: string[] = [];

function logLine(line: string, level: "info" | "warn" | "error" = "info"): void {
  recentLogs.push(line);
  if (recentLogs.length > 40) recentLogs.shift();
  const prefix = colors.cyan("[appium]");
  const body =
    level === "error" ? colors.red(line) : level === "warn" ? colors.yellow(line) : line;
  console.log(`${prefix} ${body}`);
}

function resolveAppiumBin(): string {
  const candidates = [
    join(AGENT_ROOT, "node_modules/.bin/appium"),
    join(AUTOMATION_ROOT, "node_modules/.bin/appium"),
  ];
  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }
  throw new Error(
    colors.red(
      "Appium binary not found. Run: cd ai-qa-agent && npm install && npx tsx scripts/setup-appium.ts",
    ),
  );
}

/** Fail fast with a clear message if Appium cannot print its version (e.g. missing @colors/colors). */
export function verifyAppiumInstall(): void {
  const bin = resolveAppiumBin();
  try {
    const version = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    logLine(`Appium ${version} (${bin})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Appium install is broken (${msg}). Fix with:\n` +
        `  cd ToastOperatorApp/ToastUnifiedInventory/ai-qa-agent\n` +
        `  rm -rf node_modules && npm install\n` +
        `  npx tsx scripts/setup-appium.ts`,
    );
  }
}

function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function appiumStatusReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://${APPIUM_HOST}:${APPIUM_PORT}/status`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { value?: { ready?: boolean } };
    return body.value?.ready === true;
  } catch {
    return false;
  }
}

async function isAppiumRunning(): Promise<boolean> {
  if (!(await portOpen(APPIUM_HOST, APPIUM_PORT, 800))) return false;
  return appiumStatusReady();
}

function spawnAppium(): ChildProcess {
  const bin = resolveAppiumBin();
  logLine(`Starting process: ${bin} --port ${APPIUM_PORT}`);

  const proc = spawn(bin, ["--port", String(APPIUM_PORT)], {
    cwd: AGENT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    chunk
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((l) => logLine(l));
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    chunk
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((l) => {
        if (l.includes("Cannot find module '@colors/colors'")) {
          logLine(
            "Missing @colors/colors — run: npm install @colors/colors",
            "error",
          );
        } else if (!l.includes("Debugger attached")) {
          logLine(`stderr: ${l}`, "warn");
        }
      });
  });

  proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      logLine(`Appium exited with code ${code}`, "error");
    }
    if (signal) logLine(`Appium killed by signal ${signal}`, "warn");
    if (managedProcess === proc) managedProcess = null;
  });

  return proc;
}

function formatStartupFailure(): string {
  const tail = recentLogs.slice(-10).join("\n  ");
  return (
    colors.red(
      `Appium did not become ready on http://${APPIUM_HOST}:${APPIUM_PORT} within 120s.`,
    ) +
    `\nFix:\n` +
    `  1. cd ToastOperatorApp/ToastUnifiedInventory/ai-qa-agent\n` +
    `  2. npm install && npx tsx scripts/setup-appium.ts\n` +
    `  3. npm run appium   (keep this terminal open)\n` +
    `  4. npm run dev:server   (separate terminal)\n` +
    (tail ? `\nRecent Appium output:\n  ${tail}` : "")
  );
}

export async function ensureAppiumRunning(onLog?: (msg: string) => void): Promise<void> {
  verifyAppiumInstall();

  if (await isAppiumRunning()) {
    const msg = `Appium already running on ${APPIUM_HOST}:${APPIUM_PORT}`;
    onLog?.(msg);
    logLine(msg);
    return;
  }

  if (process.env.APPIUM_AUTO_START === "false") {
    throw new Error(
      `Appium is not running on http://${APPIUM_HOST}:${APPIUM_PORT}. ` +
        `Start it: cd ai-qa-agent && npm run appium`,
    );
  }

  if (starting) {
    await starting;
    if (await isAppiumRunning()) return;
  }

  starting = (async () => {
    onLog?.(`Starting Appium on ${APPIUM_HOST}:${APPIUM_PORT}…`);
    logLine(`Starting Appium on ${APPIUM_HOST}:${APPIUM_PORT}…`);

    if (!managedProcess || managedProcess.killed || managedProcess.exitCode !== null) {
      managedProcess = spawnAppium();
    }

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await isAppiumRunning()) {
        onLog?.("Appium ready");
        logLine(colors.green("Appium ready"));
        return;
      }
      if (managedProcess?.exitCode !== null && managedProcess?.exitCode !== undefined) {
        throw new Error(formatStartupFailure());
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(formatStartupFailure());
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
}

export function stopManagedAppium(): void {
  if (managedProcess && !managedProcess.killed) {
    managedProcess.kill("SIGTERM");
    managedProcess = null;
  }
}
