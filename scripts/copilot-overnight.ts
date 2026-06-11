#!/usr/bin/env npx tsx
/**
 * Overnight preflight: analyze main diff → log recommended agent command (no execution).
 * For full post-merge CI (detect → run → report), use `npm run copilot:merge-test`.
 *
 * Schedule via cron: 0 2 * * * cd .../ai-qa-agent && npm run copilot:overnight
 */
import { config } from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CopilotService } from "../copilot/CopilotService.js";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const copilot = new CopilotService();
const preflight = copilot.preflight(
  { gitBase: process.env.COPILOT_GIT_BASE ?? "main" },
  (message, phase) => console.log(`[${phase}] ${message}`),
);

console.log("\n--- Overnight recommendation ---");
console.log(`Risk: ${preflight.featureAnalysis.risk}`);
console.log(`Flows: ${preflight.recommendedFlowIds.join(", ") || "(none)"}`);
console.log(`Command: ${preflight.recommendedCommand}`);
console.log(JSON.stringify(preflight, null, 2));
