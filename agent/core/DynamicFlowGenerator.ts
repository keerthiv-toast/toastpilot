import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import type { JiraContext, TestPlan, TestStep } from "../types.js";
import { OpenAIClient } from "./OpenAIClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS_PATH = join(__dirname, "../../knowledge/inventory-flows.json");

type FlowStepConfig = { id: string; action: string; description: string };
type FlowConfig = { id: string; name: string; aliases: string[]; steps: FlowStepConfig[]; sessionPolicy?: "fresh" | "reuse" };
type FlowsConfig = { flows: FlowConfig[] };

/** Fetch the unified diff for a PR from GitHub Enterprise. */
async function fetchPrDiff(prNumber: number): Promise<string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const repo = process.env.GITHUB_REPO ?? "toasttab/operator-app-ios";
  const host = process.env.GITHUB_API_HOST ?? "github.toasttab.com/api/v3";

  const url = `https://${host}/repos/${repo}/pulls/${prNumber}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.diff",
    "User-Agent": "ToastPilot-QA-Agent",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub diff fetch failed: ${res.status} ${res.statusText}`);
  const diff = await res.text();
  // Keep only lines touching ToastUnifiedInventory Swift/TS files — strip binary blobs
  return diff
    .split("\n")
    .filter((line) => {
      if (line.startsWith("diff --git") && !line.includes("ToastUnifiedInventory")) return false;
      return true;
    })
    .join("\n")
    .slice(0, 8000);
}

/**
 * Generates a custom test flow for a PR that has no pre-existing flow mapping.
 * Writes the generated flow into inventory-flows.json under a temporary
 * "dynamic-<runId>" id so TestPlanGenerator can resolve it normally.
 */
export class DynamicFlowGenerator {
  private readonly openai = new OpenAIClient();

  /**
   * Returns a fully-resolved TestPlan, or null if:
   *  - OpenAI is not configured
   *  - The diff contains no UI-testable changes
   *  - AI generates too few safe steps
   */
  async generate(opts: {
    prNumber?: number;
    prTitle: string;
    jiraContext: JiraContext;
  }): Promise<TestPlan | null> {
    if (!this.openai.isAvailable) {
      console.log("[dynamic-flow] OpenAI not configured — skipping dynamic generation");
      return null;
    }

    // Fetch PR diff if a PR number was supplied
    let prDiff = "";
    if (opts.prNumber) {
      try {
        prDiff = await fetchPrDiff(opts.prNumber);
        console.log(`[dynamic-flow] Fetched diff for PR #${opts.prNumber} (${prDiff.length} chars)`);
      } catch (err) {
        console.warn(`[dynamic-flow] Could not fetch PR diff: ${err instanceof Error ? err.message : err}`);
        // Proceed without diff — OpenAI will rely solely on the Jira ticket
      }
    }

    const result = await this.openai.generateDynamicFlow({
      ticketKey: opts.jiraContext.ticketKey,
      ticketSummary: opts.jiraContext.summary,
      ticketDescription: opts.jiraContext.description,
      acceptanceCriteria: opts.jiraContext.acceptanceCriteria,
      prTitle: opts.prTitle,
      prDiff,
    });

    if (!result) return null;

    const dynamicFlowId = `dynamic-${opts.jiraContext.ticketKey.toLowerCase()}-${uuid().slice(0, 8)}`;

    // Persist the generated flow into inventory-flows.json so the rest of the
    // pipeline (TestPlanGenerator, AgentOrchestrator handlers) can use it.
    this.persistFlow(dynamicFlowId, result.flowName, result.steps);

    const testSteps: TestStep[] = result.steps.map((s) => ({
      id: s.id,
      action: s.action,
      description: s.description,
      status: "pending",
      logs: [],
    }));

    const plan: TestPlan = {
      id: uuid(),
      flowId: dynamicFlowId,
      flowIds: [dynamicFlowId],
      flowName: `${opts.jiraContext.ticketKey}: ${result.flowName}`,
      command: opts.prTitle,
      steps: testSteps,
      sessionPolicy: "fresh",
      createdAt: new Date().toISOString(),
      estimatedDurationSec: testSteps.length * 25,
    };

    console.log(
      `[dynamic-flow] Generated plan "${result.flowName}" with ${testSteps.length} steps` +
      ` for ${opts.jiraContext.ticketKey}. Rationale: ${result.rationale}`,
    );

    return plan;
  }

  /** Write the generated flow into inventory-flows.json so AgentOrchestrator can find it. */
  private persistFlow(flowId: string, flowName: string, steps: FlowStepConfig[]): void {
    try {
      const config = JSON.parse(readFileSync(FLOWS_PATH, "utf-8")) as FlowsConfig;

      // Remove any previous dynamic entry for this same ticket to keep the file tidy
      config.flows = config.flows.filter((f) => !f.id.startsWith("dynamic-"));

      config.flows.push({
        id: flowId,
        name: flowName,
        aliases: [flowId],
        steps,
        sessionPolicy: "fresh",
      });

      writeFileSync(FLOWS_PATH, JSON.stringify(config, null, 2));
      console.log(`[dynamic-flow] Persisted flow "${flowId}" → inventory-flows.json`);
    } catch (err) {
      console.error("[dynamic-flow] Failed to persist flow:", err);
    }
  }
}
