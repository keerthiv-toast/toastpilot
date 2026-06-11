#!/usr/bin/env npx tsx
/**
 * Standalone locator codegen script.
 *
 * Usage:
 *   npm run locators:generate            # scan only Swift files changed since last merge
 *   npm run locators:generate:all        # scan ALL Swift sources (full refresh)
 *   npm run locators:generate -- --dry-run   # preview without writing
 *   npm run locators:generate -- --since=abc123
 */
import { runCodegen } from "../agent/executor/LocatorCodegen.js";
import { getMergeTestContext } from "../copilot/mergeDetection.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allFiles = args.includes("--all");
const dryRun = args.includes("--dry-run");
const sinceArg = args.find((a) => a.startsWith("--since="))?.split("=")[1];

async function main() {
  console.log("ToastPilot — Locator Codegen\n");

  let changedSwiftFiles: string[] | undefined;

  if (!allFiles) {
    const merge = getMergeTestContext({ sinceRef: sinceArg });
    changedSwiftFiles = merge.changedFiles
      .filter((f) => f.endsWith(".swift"))
      .map((f) => `${ROOT}/../../../${f}`);

    if (changedSwiftFiles.length === 0) {
      console.log("No changed Swift files detected. Running full scan instead.");
      changedSwiftFiles = undefined;
    } else {
      console.log(`Scanning ${changedSwiftFiles.length} changed Swift file(s)…`);
    }
  } else {
    console.log("Full scan mode — scanning all Swift sources…");
  }

  const result = runCodegen({ changedSwiftFiles, allFiles, dryRun });

  console.log(`\nResult:`);
  console.log(`  Total locators written : ${result.totalWritten}`);
  console.log(`  New (this run)         : ${result.added.length}`);
  console.log(`  Unchanged              : ${result.unchanged}`);
  console.log(`  Auto-promoted to L map : ${result.promoted}`);
  console.log(`  Output                 : ${result.outputPath}`);

  if (result.added.length > 0) {
    console.log(`\n🆕 New locators:`);
    for (const loc of result.added) {
      const file = loc.sourceFile.split("/").pop() ?? loc.sourceFile;
      console.log(`   ${loc.selector.padEnd(50)}  ← ${file}`);
    }
  }

  if (dryRun) {
    console.log("\n(dry-run — files not written)");
  } else {
    console.log("\n✓ generated-locators.ts updated.");
    if (result.promoted > 0) {
      console.log(`✓ ${result.promoted} new locator(s) auto-promoted into FlowActions.ts L map.`);
      console.log("  Dynamic IDs include First/Second/Nth XPath variants.");
    }
  }
}

main().catch((err) => {
  console.error("Codegen failed:", err);
  process.exit(1);
});
