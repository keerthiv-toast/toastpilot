import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import type { JiraContext, TestPlan, TestStep } from "../types.js";
import { OpenAIClient } from "./OpenAIClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
type FlowStepConfig = { id: string; action: string; description: string };

type FlowConfig = {
  id: string;
  name: string;
  aliases: string[];
  steps?: FlowStepConfig[];
  sessionPolicy?: "fresh" | "reuse";
  extends?: string;
  additionalSteps?: FlowStepConfig[];
};

type FlowsConfig = {
  flows: FlowConfig[];
};

/** Higher = wins ties between flows. */
const FLOW_PRIORITY: Record<string, number> = {
  "full-regression": 110,
  "full-smoke": 108,
  "cycle-count-smoke": 100,
  "cycle-count-from-template": 97,
  "post-submission-ui": 95,
  "edit-item": 90,
  "add-item-location": 88,
  "add-new-item": 86,
  "login-only": 82,
  "logout-only": 84,
  "product-catalog-regression": 99,
  "invoice-scanning-regression": 98,
  "pc-filter-refresh": 96,
  "product-catalog-add-edit-delete": 85,
  "product-catalog-details": 80,
  "product-catalog-filters": 79,
  "product-catalog": 78,
  "upload-invoice": 79,
  "invoice-landscape-popup": 78,
  "invoice-scanning": 77,
  "cycle-count": 65,
  "minimal-smoke": 55,
};

/** Run once per session — duplicates are dropped from extended/combined flows. */
const DEDUP_ONCE_ACTIONS = new Set([
  "bootSimulator",
  "launchApp",
  "ensureLoggedIn",
  "navigateToInventoryTab",
  "verifyInventoryHome",
]);

const STOPWORDS = new Set([
  "test",
  "the",
  "a",
  "an",
  "run",
  "please",
  "what",
  "is",
  "my",
  "do",
  "flow",
  "only",
  "inventory",
  "unified",
  "toast",
  "operator",
]);

function loadFlowsConfig(): FlowsConfig {
  return JSON.parse(
    readFileSync(join(__dirname, "../../knowledge/inventory-flows.json"), "utf-8"),
  ) as FlowsConfig;
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string, stripStopwords = false): string[] {
  const norm = normalizeText(input);
  if (!norm) return [];
  const tokens = norm.split(" ").filter(Boolean);
  return stripStopwords ? tokens.filter((t) => !STOPWORDS.has(t)) : tokens;
}

function hasToken(tokens: Set<string>, normalized: string, word: string): boolean {
  return tokens.has(word) || normalized.includes(word);
}

/**
 * Split on `and` when it joins separate flow intents (not inside a single phrase).
 * e.g. "login flow and edit flow" → ["login flow", "edit flow"]
 */
export function splitCombinedCommand(command: string): string[] | null {
  const parts = command
    .split(/\s+and\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
  return parts.length >= 2 ? parts : null;
}

/**
 * Deterministic intent routing for partial / voice commands.
 */
function matchFlowByIntent(command: string): string | null {
  const normalized = normalizeText(command);
  const tokens = new Set(tokenize(command, true));

  const has = (word: string) => hasToken(tokens, normalized, word);
  const hasPhrase = (phrase: string) => normalized.includes(normalizeText(phrase));

  if (has("demo") && has("failure")) return "cycle-count";

  // Full-app cross-module flows — must come before any module-specific checks
  if (
    hasPhrase("full app regression") ||
    hasPhrase("full regression") && (has("all") || has("app") || has("modules")) ||
    hasPhrase("all modules regression") ||
    hasPhrase("entire app regression") ||
    hasPhrase("e2e regression") ||
    hasPhrase("end to end regression")
  ) return "full-regression";

  if (
    hasPhrase("full app smoke") ||
    hasPhrase("full smoke") ||
    hasPhrase("all modules smoke") ||
    hasPhrase("end to end smoke") ||
    hasPhrase("e2e smoke") ||
    hasPhrase("app smoke")
  ) return "full-smoke";

  // Check module-specific regression phrases BEFORE the generic "regression" fallback
  if (has("catalog") || hasPhrase("product catalog")) {
    if (has("regression") || hasPhrase("full regression") || hasPhrase("entire flow") || hasPhrase("end to end") || has("e2e") || (has("full") && has("catalog"))) {
      return "product-catalog-regression";
    }
  }
  if (has("invoice")) {
    if (has("regression") || hasPhrase("full regression") || hasPhrase("entire flow") || hasPhrase("end to end") || has("e2e") || (has("full") && has("invoice"))) {
      return "invoice-scanning-regression";
    }
  }

  if (has("regression") || hasPhrase("entire regression")) return "cycle-count-smoke";
  if (has("full") && has("smoke") && !has("app") && !has("all") && !has("modules")) return "cycle-count-smoke";

  if (has("submission") && (has("post") || has("validate"))) return "post-submission-ui";

  if (
    hasPhrase("cycle count from template") ||
    hasPhrase("count from template") ||
    hasPhrase("start count from template") ||
    hasPhrase("no count sheet") ||
    hasPhrase("create count sheet from template") ||
    (has("template") && (has("cycle") || has("count")))
  ) return "cycle-count-from-template";

  if (has("edit") && (has("item") || hasPhrase("edit flow") || hasPhrase("edit item"))) {
    return "edit-item";
  }

  if (has("location") && (has("item") || hasPhrase("item location"))) return "add-item-location";

  if (
    hasPhrase("upload invoice") ||
    hasPhrase("add invoice") ||
    hasPhrase("upload invoice flow") ||
    (has("upload") && has("invoice"))
  ) {
    return "upload-invoice";
  }

  if (
    hasPhrase("invoice landscape") ||
    hasPhrase("landscape invoice") ||
    hasPhrase("landscape popup") ||
    hasPhrase("low image quality") ||
    hasPhrase("low quality popup") ||
    hasPhrase("handle landscape") ||
    (has("landscape") && has("invoice"))
  ) {
    return "invoice-landscape-popup";
  }

  if (
    hasPhrase("manage invoice") ||
    hasPhrase("manage invoices") ||
    hasPhrase("invoice management") ||
    hasPhrase("invoice scanning")
  ) {
    return "invoice-scanning";
  }

  if (
    hasPhrase("add new item") ||
    (has("add") && has("item") && !has("location") && !has("invoice"))
  ) {
    return "add-new-item";
  }

  if (has("logout") || hasPhrase("log out") || hasPhrase("logout flow") || hasPhrase("sign out")) {
    return "logout-only";
  }

  if ((has("login") || hasPhrase("login flow")) && !has("logout")) return "login-only";

  // PC filter refresh — must be checked before generic catalog/filter routing
  if (
    hasPhrase("filter refresh") ||
    hasPhrase("refresh filter") ||
    hasPhrase("filter count") ||
    hasPhrase("pc filter") ||
    (has("filter") && has("refresh")) ||
    (has("filter") && has("instant")) ||
    (has("filter") && has("update") && (has("catalog") || has("product")))
  ) {
    return "pc-filter-refresh";
  }

  // Product catalog — most-specific patterns first so "entire flow / e2e / regression" wins.
  if (has("catalog") || hasPhrase("product catalog")) {
    if (
      hasPhrase("entire flow") ||
      hasPhrase("end to end") ||
      hasPhrase("full regression") ||
      hasPhrase("e2e") ||
      hasPhrase("all tests") ||
      (has("entire") && has("catalog")) ||
      (has("full") && has("catalog")) ||
      (has("e2e") && has("catalog"))
    ) {
      return "product-catalog-regression";
    }
    if (has("filter") || has("filters") || has("sort")) return "product-catalog-filters";
    if (has("detail") || has("details")) return "product-catalog-details";
    if (
      (has("add") && has("edit") && has("delete")) ||
      has("crud") ||
      (has("add") && has("delete")) ||
      (has("create") && has("delete"))
    ) {
      return "product-catalog-add-edit-delete";
    }
    return "product-catalog";
  }

  if (has("smoke") && !has("full") && !has("regression")) return "minimal-smoke";
  if (hasPhrase("minimal smoke") || hasPhrase("smoke minimal")) return "minimal-smoke";

  if (has("cycle") && has("count")) return "cycle-count";
  if (has("count") && has("sheet")) return "cycle-count";

  return null;
}

function flowPriority(flowId: string): number {
  return FLOW_PRIORITY[flowId] ?? 0;
}

function findFlow(flows: FlowConfig[], id: string): FlowConfig | undefined {
  return flows.find((f) => f.id === id);
}

function expandFlowSteps(flow: FlowConfig, flowsConfig: FlowsConfig): FlowStepConfig[] {
  let steps = [...(flow.steps ?? [])];

  if (flow.extends) {
    const parent = flowsConfig.flows.find((f) => f.id === flow.extends);
    if (parent) {
      const parentSteps = parent.steps ?? [];
      // Only keep child steps whose action doesn't already exist in the parent —
      // prevents double-running openProductCatalog, verifyProductCatalog, etc.
      const parentActions = new Set(parentSteps.map((s) => s.action));
      const uniqueChildSteps = steps.filter((s) => !parentActions.has(s.action));
      steps = [...parentSteps, ...uniqueChildSteps];
    }
  }

  if (flow.additionalSteps) {
    steps = [...steps, ...flow.additionalSteps];
  }

  // Deduplicate once-per-session setup actions (handles inline-combined flows
  // like invoice-scanning-regression that repeat boot/login/nav across merged sub-flows).
  const seenOnce = new Set<string>();
  return steps.filter((s) => {
    if (!DEDUP_ONCE_ACTIONS.has(s.action)) return true;
    if (seenOnce.has(s.action)) return false;
    seenOnce.add(s.action);
    return true;
  });
}

function resolveFlowByAliases(command: string, flows: FlowConfig[]): FlowConfig | undefined {
  const normalized = normalizeText(command);
  const commandTokens = new Set(tokenize(command, true));
  const allCommandTokens = new Set(tokenize(command, false));

  let matched: FlowConfig | undefined;
  let bestScore = -1;

  for (const flow of flows) {
    for (const alias of flow.aliases) {
      const a = normalizeText(alias);
      if (!a) continue;
      if (normalized.includes(a)) {
        const score = a.length * 1000 + flowPriority(flow.id);
        if (score > bestScore) {
          bestScore = score;
          matched = flow;
        }
      }
    }
  }

  if (!matched) {
    for (const flow of flows) {
      for (const alias of flow.aliases) {
        const aliasTokens = tokenize(alias, true);
        if (aliasTokens.length === 0) continue;

        let hit = 0;
        for (const t of aliasTokens) {
          if (commandTokens.has(t) || allCommandTokens.has(t)) hit++;
        }
        const ratio = hit / aliasTokens.length;
        const minRatio = aliasTokens.length <= 2 ? 1 : 0.75;

        if (ratio >= minRatio) {
          const score = ratio * 100 + aliasTokens.length + flowPriority(flow.id) / 100;
          if (score > bestScore) {
            bestScore = score;
            matched = flow;
          }
        }
      }
    }
  }

  return matched;
}

/** Resolve one flow from a command segment (intent → exact ID → aliases). */
export function resolveFlowForSegment(
  segment: string,
  flowsConfig: FlowsConfig,
): FlowConfig | null {
  // Exact flow-id match (handles bare IDs sent from the UI dropdown, e.g. "full-regression")
  const exactById = findFlow(flowsConfig.flows, segment.trim());
  if (exactById) return exactById;

  const intentFlowId = matchFlowByIntent(segment);
  if (intentFlowId) {
    const flow = findFlow(flowsConfig.flows, intentFlowId);
    if (flow) return flow;
  }
  return resolveFlowByAliases(segment, flowsConfig.flows) ?? null;
}

/** Resolve all flows for a command (supports `and` combined flows). */
export function resolveFlowsFromCommand(command: string): FlowConfig[] {
  const flowsConfig = loadFlowsConfig();
  const trimmed = command.trim();
  if (!trimmed) return [];

  const segments = splitCombinedCommand(trimmed);
  if (segments) {
    const flows: FlowConfig[] = [];
    for (const segment of segments) {
      const flow = resolveFlowForSegment(segment, flowsConfig);
      if (!flow) return [];
      flows.push(flow);
    }
    return flows;
  }

  const flow = resolveFlowForSegment(trimmed, flowsConfig);
  return flow ? [flow] : [];
}

/** Expanded step list for one or more flows (includes `extends` / additionalSteps). */
export function expandedStepsForFlows(flows: FlowConfig[]): FlowStepConfig[] {
  const flowsConfig = loadFlowsConfig();
  return flows.flatMap((flow) => expandFlowSteps(flow, flowsConfig));
}

/**
 * Derive extra test steps from Jira AC lines that aren't already covered by
 * the base flow steps. Each AC line is mapped to the most appropriate action.
 */
function acStepsFromJiraContext(jiraContext: JiraContext): FlowStepConfig[] {
  const steps: FlowStepConfig[] = [];
  const ac = jiraContext.acceptanceCriteria;
  const summary = jiraContext.summary.toLowerCase();
  const allText = [summary, ...ac.map((l) => l.toLowerCase())].join(" ");

  // Landscape / orientation checks
  if (/landscape/i.test(allText) || /orientation/i.test(allText)) {
    steps.push({
      id: `jira-ac-landscape-${jiraContext.ticketKey}`,
      action: "verifyLowQualityPopupLandscape",
      description: `[${jiraContext.ticketKey}] Rotate to landscape and verify low-quality popup is fully visible (modal width + text not clipped)`,
    });
  }

  // Modal / popup text visibility checks
  if (/modal|pop.?up|dialog/i.test(allText) && /text|message|label/i.test(allText)) {
    if (!/landscape/i.test(allText)) {
      // Generic: verify the modal is fully visible in portrait if landscape already covered
      steps.push({
        id: `jira-ac-modal-text-${jiraContext.ticketKey}`,
        action: "verifyInvoiceManagement",
        description: `[${jiraContext.ticketKey}] Verify modal/popup text is fully visible and not truncated`,
      });
    }
  }

  // AC line level: each acceptance criterion becomes a labelled verification step
  for (let i = 0; i < ac.length; i++) {
    const line = ac[i];
    if (!line?.trim()) continue;

    // Skip if already covered by a specific step above
    if (/landscape/i.test(line) || /orientation/i.test(line)) continue;

    // Map known patterns to actions
    if (/manage.invoice|invoice.list|upload.invoice/i.test(line)) {
      steps.push({
        id: `jira-ac-${i}-${jiraContext.ticketKey}`,
        action: "verifyInvoiceManagement",
        description: `[${jiraContext.ticketKey} AC ${i + 1}] ${line}`,
      });
    } else if (/image.quality|low.quality|quality.pop/i.test(line)) {
      // Only add if landscape step not already added
      if (!steps.some((s) => s.action === "verifyLowQualityPopupLandscape")) {
        steps.push({
          id: `jira-ac-${i}-${jiraContext.ticketKey}`,
          action: "verifyLowQualityPopupLandscape",
          description: `[${jiraContext.ticketKey} AC ${i + 1}] ${line}`,
        });
      }
    }
  }

  return steps;
}

export class TestPlanGenerator {
  private readonly openai = new OpenAIClient();

  async generate(command: string, jiraContext?: JiraContext): Promise<TestPlan> {
    const flowsConfig = loadFlowsConfig();
    const trimmed = command.trim();

    const segments = splitCombinedCommand(trimmed);
    if (segments) {
      const flows: FlowConfig[] = [];
      for (const segment of segments) {
        const flow = resolveFlowForSegment(segment, flowsConfig);
        if (!flow) {
          throw new Error(
            `Could not match a test flow for "${segment}". Try clearer names (e.g. login flow, edit item flow, upload invoice flow).`,
          );
        }
        flows.push(flow);
      }
      return this.planFromFlows(trimmed, flowsConfig, flows, jiraContext);
    }

    const flow = resolveFlowForSegment(trimmed, flowsConfig);
    if (flow) {
      return this.planFromFlow(trimmed, flowsConfig, flow, jiraContext);
    }

    const aiPlan = await this.openai.generateTestPlan(trimmed);
    if (aiPlan) return aiPlan;

    throw new Error(
      `No test flow matched for command "${trimmed}". Use a known flow name (e.g. "Test Cycle Count flow", "Test upload invoice flow") or a Jira ticket ID (e.g. SMB-1168) with Jira configured in .env.`,
    );
  }

  /**
   * Build a TestPlan directly from a pre-generated dynamic flow definition.
   * Called by AgentOrchestrator when runCommand receives a dynamic-* flowId
   * that was already written to inventory-flows.json by DynamicFlowGenerator.
   */
  generateFromDynamicFlow(dynamicFlowId: string, jiraContext?: JiraContext): TestPlan | null {
    try {
      const flowsConfig = loadFlowsConfig();
      const flow = flowsConfig.flows.find((f) => f.id === dynamicFlowId);
      if (!flow) return null;
      return this.planFromFlow(dynamicFlowId, flowsConfig, flow, jiraContext);
    } catch {
      return null;
    }
  }

  private planFromFlows(
    command: string,
    flowsConfig: FlowsConfig,
    flows: FlowConfig[],
    jiraContext?: JiraContext,
  ): TestPlan {
    const seenOnce = new Set<string>();
    const mergedSteps: FlowStepConfig[] = [];
    const flowIds = flows.map((f) => f.id);
    const multi = flows.length > 1;

    for (const flow of flows) {
      const steps = expandFlowSteps(flow, flowsConfig);
      for (const step of steps) {
        if (DEDUP_ONCE_ACTIONS.has(step.action)) {
          if (seenOnce.has(step.action)) continue;
          seenOnce.add(step.action);
        }

        mergedSteps.push({
          id: multi ? `${flow.id}__${step.id}` : step.id,
          action: step.action,
          description: multi ? `[${flow.name}] ${step.description}` : step.description,
        });
      }
    }

    // Append AC-derived steps only when the flow doesn't already encode the AC scenario
    const acFlows = new Set(["invoice-landscape-popup"]);
    if (jiraContext && !flowIds.some((id) => acFlows.has(id))) {
      mergedSteps.push(...acStepsFromJiraContext(jiraContext));
    }

    const testSteps: TestStep[] = mergedSteps.map((s) => ({
      id: s.id,
      action: s.action,
      description: s.description,
      status: "pending",
      logs: [],
    }));

    const sessionPolicy = flows.some((f) => (f.sessionPolicy ?? "fresh") === "fresh")
      ? "fresh"
      : "reuse";

    return {
      id: uuid(),
      flowId: flowIds.join("+"),
      flowIds,
      flowName: jiraContext ? `${jiraContext.ticketKey}: ${jiraContext.summary}` : command,
      command,
      steps: testSteps,
      sessionPolicy,
      createdAt: new Date().toISOString(),
      estimatedDurationSec: testSteps.length * 25,
    };
  }

  private planFromFlow(command: string, flowsConfig: FlowsConfig, flow: FlowConfig, jiraContext?: JiraContext): TestPlan {
    const baseSteps = expandFlowSteps(flow, flowsConfig);
    const acFlows = new Set(["invoice-landscape-popup"]);
    const acSteps = (jiraContext && !acFlows.has(flow.id)) ? acStepsFromJiraContext(jiraContext) : [];
    const steps = [...baseSteps, ...acSteps];

    const testSteps: TestStep[] = steps.map((s) => ({
      id: s.id,
      action: s.action,
      description: s.description,
      status: "pending",
      logs: [],
    }));

    return {
      id: uuid(),
      flowId: flow.id,
      flowIds: [flow.id],
      flowName: jiraContext ? `${jiraContext.ticketKey}: ${jiraContext.summary}` : command.trim(),
      command: command.trim(),
      steps: testSteps,
      sessionPolicy: flow.sessionPolicy,
      createdAt: new Date().toISOString(),
      estimatedDurationSec: testSteps.length * 25,
    };
  }
}
