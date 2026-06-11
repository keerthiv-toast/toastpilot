#!/usr/bin/env npx tsx
/**
 * Standalone feature codegen — generate all automation artifacts for a Jira ticket.
 *
 * Usage:
 *   npm run feature:generate -- --ticket=SMB-1234 --summary="My feature" --ac="AC text" --dry-run
 *   npm run feature:generate -- --ticket=SMB-1234  # reads AC from COPILOT_PR_BODY env
 */
import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateFeatureCode } from "../agent/core/FeatureCodegen.js";
import { runCodegen } from "../agent/executor/LocatorCodegen.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(ROOT, ".env") });

const args = process.argv.slice(2);
const dryRun   = args.includes("--dry-run");
const ticket   = args.find((a) => a.startsWith("--ticket="))?.split("=").slice(1).join("=") ?? "";
const summary  = args.find((a) => a.startsWith("--summary="))?.split("=").slice(1).join("=") ?? ticket;
const acArg    = args.find((a) => a.startsWith("--ac="))?.split("=").slice(1).join("=");
const flowId   = args.find((a) => a.startsWith("--flow-id="))?.split("=").slice(1).join("=");

if (!ticket) {
  console.error("Usage: npm run feature:generate -- --ticket=SMB-XXXX [--summary=...] [--ac=...] [--dry-run]");
  process.exit(1);
}

async function main() {
  console.log(`\nToastPilot — Feature Codegen for ${ticket}\n`);

  // 1. Run locator codegen first to pick up any new locators from this feature's Swift files
  console.log("Step 1: Scanning locators…");
  const codegenResult = runCodegen({ allFiles: true, dryRun });
  console.log(`  ${codegenResult.added.length} new locator(s) found`);
  if (codegenResult.promoted > 0) {
    console.log(`  ${codegenResult.promoted} promoted into FlowActions.L`);
  }

  // 2. Generate automation code
  console.log("\nStep 2: Generating automation code…");
  const ac = acArg ?? process.env.COPILOT_PR_BODY ?? summary;
  const suggestedFlowId = flowId ?? `${ticket.toLowerCase()}-${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;

  const result = await generateFeatureCode({
    ticketKey: ticket,
    summary,
    acceptanceCriteria: ac,
    newLocatorIds: codegenResult.added.map((l) => l.id),
    suggestedFlowId,
  }, { dryRun });

  console.log(`\nResult:`);
  console.log(`  Flow ID          : ${result.flowId}`);
  console.log(`  Action methods   : ${result.actionNames.join(", ") || "(none)"}`);
  console.log(`  Files written    : ${result.filesWritten}`);
  if (result.regressionFlowId) {
    const added = result.regressionStepsAdded ?? 0;
    console.log(`  Regression flow  : ${result.regressionFlowId} (+${added} step${added !== 1 ? "s" : ""})`);
  }

  if (result.actionNames.length > 0) {
    console.log(`\nGenerated methods:\n${result.actionMethods.slice(0, 800)}${result.actionMethods.length > 800 ? "\n  …" : ""}`);
  }

  if (dryRun) {
    console.log("\n(dry-run — no files modified)");
  } else {
    console.log("\n✓ Done. Run the new flow with:");
    console.log(`  npm run agent:run -- "Test ${summary}"`);
  }
}

main().catch((err) => {
  console.error("Feature codegen failed:", err);
  process.exit(1);
});
