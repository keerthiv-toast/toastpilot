#!/usr/bin/env npx tsx
/**
 * Post-merge CI entry point for Toast Unified Inventory.
 *
 * 1. Detect files changed in ToastUnifiedInventory since last merge / CI before SHA
 * 2. Map to regression flows + build recommended command
 * 3. Build app, start Appium, run tests headlessly
 * 4. Write executive summary (JSON + HTML) and exit non-zero on failure
 *
 * Usage:
 *   npm run copilot:merge-test
 *   npm run copilot:merge-test -- --dry-run
 *   COPILOT_BEFORE_SHA=abc123 COPILOT_AFTER_SHA=def456 npm run copilot:merge-test
 *
 * Jenkins (after merge to main, Unified Inventory changed):
 *   cd ToastOperatorApp/ToastUnifiedInventory/ai-qa-agent
 *   npm ci && npm run setup && npm run copilot:merge-test
 */
import { config } from "dotenv";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AgentOrchestrator } from "../agent/core/AgentOrchestrator.js";
import { CopilotService } from "../copilot/CopilotService.js";
import { getMergeTestContext } from "../copilot/mergeDetection.js";
import { ensureAppiumRunning } from "../agent/executor/AppiumLauncher.js";
import { runCodegen } from "../agent/executor/LocatorCodegen.js";
import { generateFeatureCode } from "../agent/core/FeatureCodegen.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(ROOT, ".env") });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const sinceArg = args.find((a) => a.startsWith("--since="))?.split("=")[1];

function log(section: string, msg: string): void {
  console.log(`[merge-test] ${section}: ${msg}`);
}

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ToastPilot — Post-merge QA (ToastUnifiedInventory)          ║
╚══════════════════════════════════════════════════════════════╝
`);

  const merge = getMergeTestContext({
    sinceRef: sinceArg,
    gitBase: process.env.COPILOT_GIT_BASE,
    beforeSha: process.env.COPILOT_BEFORE_SHA,
    afterSha: process.env.COPILOT_AFTER_SHA,
  });

  log("git", `range ${merge.diffRange} (since ${merge.sinceLabel}) → ${merge.headShort}`);
  log("git", `${merge.changedFiles.length} Unified Inventory file(s) changed`);

  // ── Locator codegen ──────────────────────────────────────────────────────
  // Run before tests so any new accessibility IDs from this PR are available
  // to SelectorHealer / RepoLocatorScanner during the test run.
  const changedSwiftFiles = merge.changedFiles
    .filter((f) => f.endsWith(".swift"))
    .map((f) => `${ROOT}/../../../${f}`);

  try {
    const codegen = runCodegen({
      changedSwiftFiles: changedSwiftFiles.length > 0 ? changedSwiftFiles : undefined,
    });
    if (codegen.added.length > 0) {
      log("codegen", `${codegen.added.length} new locator(s) detected and written to generated-locators.ts:`);
      for (const loc of codegen.added) {
        log("codegen", `  🆕 ${loc.selector}  (${loc.sourceFile.split("/").pop()})`);
      }
      if (codegen.promoted > 0) {
        log("codegen", `✓ ${codegen.promoted} locator(s) auto-promoted into FlowActions.ts L map`);
      }

      // ── Feature codegen — generate action methods, flow JSON, routing ──
      if (codegen.added.length > 0 && merge.jiraTicket) {
        log("feature-codegen", `Generating automation code for ${merge.jiraTicket}…`);
        try {
          const slugBase = merge.commitMessage
            .split("\n")[0]
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40);
          const flowId = `${merge.jiraTicket.toLowerCase()}-${slugBase}`.replace(/-+/g, "-");

          const fcResult = await generateFeatureCode({
            ticketKey: merge.jiraTicket,
            summary: merge.commitMessage.split("\n")[0].slice(0, 100),
            acceptanceCriteria: process.env.COPILOT_PR_BODY ?? merge.commitMessage,
            newLocatorIds: codegen.added.map((l) => l.id),
            suggestedFlowId: flowId,
          }, { dryRun });

          if (fcResult.filesWritten) {
            log("feature-codegen", `✓ Generated flow "${fcResult.flowId}" with ${fcResult.actionNames.length} action(s): ${fcResult.actionNames.join(", ")}`);
            log("feature-codegen", `✓ Routing keywords added to JiraPlanSynthesizer`);
            log("feature-codegen", `✓ Handler entries added to AgentOrchestrator`);
            if (fcResult.regressionFlowId && fcResult.regressionStepsAdded) {
              log("feature-codegen", `✓ ${fcResult.regressionStepsAdded} step(s) appended to regression flow "${fcResult.regressionFlowId}"`);
            }
            // Update command to run the newly generated flow
            const generatedCommand = `Test ${merge.jiraTicket} ${merge.commitMessage.split("\n")[0]}`;
            log("feature-codegen", `Auto-command: "${generatedCommand}"`);
          } else if (dryRun) {
            log("feature-codegen", `(dry-run) Would generate flow "${fcResult.flowId}"`);
          }
        } catch (fcErr) {
          log("feature-codegen", `⚠ Feature codegen failed (non-fatal): ${(fcErr as Error).message}`);
        }
      }
    } else {
      log("codegen", `No new locators — ${codegen.unchanged} existing IDs refreshed`);
    }
  } catch (err) {
    // Codegen failure is non-fatal — log and continue with tests
    log("codegen", `⚠ Codegen skipped: ${(err as Error).message}`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!merge.hasInventoryChanges && !force) {
    console.log("\n✓ SKIP — no ToastUnifiedInventory changes in this range. Exit 0.");
    mkdirSync(join(ROOT, "reports"), { recursive: true });
    writeFileSync(
      join(ROOT, "reports", "merge-test-skip.json"),
      JSON.stringify(
        {
          skipped: true,
          reason: "no_inventory_changes",
          diffRange: merge.diffRange,
          headSha: merge.headSha,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const copilot = new CopilotService();
  const preflight = copilot.preflight(
    {
      gitBase: process.env.COPILOT_GIT_BASE ?? "main",
      changedFilesOverride: merge.changedFiles,
      commitMessage: merge.commitMessage,
      jiraTicket: merge.jiraTicket,
      prBody: process.env.COPILOT_PR_BODY,
    },
    (message, phase) => log(phase, message),
  );

  const command = preflight.recommendedCommand;
  log("plan", `Feature: ${preflight.featureAnalysis.featureName}`);
  log("plan", `Risk: ${preflight.featureAnalysis.risk}`);
  log("plan", `Flows: ${preflight.recommendedFlowIds.join(", ")}`);
  log("plan", `Command: "${command}"`);
  log("plan", `${preflight.scenarios.length} scenario(s)`);

  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preflightPath = join(ROOT, "reports", `merge-test-${stamp}-preflight.json`);
  writeFileSync(
    preflightPath,
    JSON.stringify({ merge, preflight, command }, null, 2),
  );
  log("report", `Preflight saved: ${preflightPath}`);

  if (dryRun) {
    console.log("\n✓ DRY RUN — analysis only. Exit 0.");
    process.exit(0);
  }

  log("appium", "Ensuring Appium is running…");
  await ensureAppiumRunning((msg) => log("appium", msg));

  log("agent", "Starting autonomous test run…");
  const orchestrator = new AgentOrchestrator((event) => {
    if (event.type === "step:finished") {
      const icon = event.step.status === "passed" || event.step.status === "healed" ? "✓" : "✗";
      log("step", `${icon} ${event.step.description}`);
    }
    if (event.type === "failure:analysis") {
      log("failure", String((event.analysis as { assertion?: string }).assertion ?? "failed"));
    }
  });

  const run = await orchestrator.runCommand(command);
  const reportPath = copilot.persistReports(run, preflight, join(ROOT, "reports"), []);

  log("report", `Executive summary: ${reportPath}`);
  log("result", `Status: ${run.status.toUpperCase()} (${run.id})`);

  if (run.status === "passed") {
    console.log("\n✓ MERGE TEST PASSED");
    process.exit(0);
  }

  console.log("\n✗ MERGE TEST FAILED — see reports/ and artifacts/");
  if (run.failureExplanation) {
    console.log(`\n${run.failureExplanation}\n`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("[merge-test] fatal:", err);
  process.exit(1);
});
