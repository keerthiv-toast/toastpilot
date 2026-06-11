#!/usr/bin/env npx tsx
/**
 * One-time / post-install setup: verify Appium + install XCUITest driver.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appiumBin = join(root, "node_modules/.bin/appium");

if (!existsSync(appiumBin)) {
  console.error("Run npm install first.");
  process.exit(1);
}

console.log("Checking Appium…");
const version = execFileSync(appiumBin, ["--version"], { encoding: "utf-8" }).trim();
console.log(`Appium ${version}`);

console.log("Ensuring xcuitest driver…");
try {
  execFileSync(appiumBin, ["driver", "install", "xcuitest"], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  console.log("xcuitest driver already installed or install skipped.");
}

console.log("Setup complete. Start with: npm run dev");
