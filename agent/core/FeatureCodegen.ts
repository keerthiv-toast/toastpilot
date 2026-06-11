/**
 * FeatureCodegen — fully autonomous test code generation for new features.
 *
 * Given a Jira ticket + newly promoted locators, uses the Claude / OpenAI API
 * to generate all four artifacts needed to run tests autonomously:
 *   1. FlowActions.ts  — new async action methods
 *   2. inventory-flows.json — new flow entry with step sequence
 *   3. JiraPlanSynthesizer.ts — new FLOW_KEYWORDS entry
 *   4. AgentOrchestrator.ts — new handler entries in the action map
 *
 * The generated code is inserted into the live files so the next test run
 * picks it up immediately with zero human intervention.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const FLOW_ACTIONS_FILE   = join(ROOT, "agent/executor/FlowActions.ts");
const FLOWS_JSON_FILE     = join(ROOT, "knowledge/inventory-flows.json");
const SYNTHESIZER_FILE    = join(ROOT, "jira/JiraPlanSynthesizer.ts");
const ORCHESTRATOR_FILE   = join(ROOT, "agent/core/AgentOrchestrator.ts");

// Markers for the auto-generated sections so re-runs replace, not append
const FA_CODEGEN_START  = "  // ── feature-codegen actions start ──";
const FA_CODEGEN_END    = "  // ── feature-codegen actions end ──";
const ORC_CODEGEN_START = "      // ── feature-codegen handlers start ──";
const ORC_CODEGEN_END   = "      // ── feature-codegen handlers end ──";

// ── Few-shot examples embedded in prompts ─────────────────────────────────

const FLOW_ACTION_EXAMPLE = `
  async openProductCatalog(): Promise<void> {
    await this.session.waitForDisplayed(L.productCatalogPreview, 15000);
    await this.session.scroll("down");
    await this.session.pause(800);
    const viewAllScoped =
      '//XCUIElementTypeOther[@name="product_catalog_preview"]//XCUIElementTypeButton[@name="view_all_button"]';
    await this.session.waitForDisplayed(viewAllScoped, 10000);
    await this.session.tap(viewAllScoped, { timeout: 8000 });
    await this.session.pause(2500);
    const onCatalog =
      (await this.session.isDisplayed(L.productCatalogAddButton)) ||
      (await this.session.isDisplayed(L.productCatalogBarcodeScanner));
    if (!onCatalog) throw new Error("openProductCatalog: not on catalog screen");
  }

  async applyLowStockFilter(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (await this.session.isDisplayed(L.productCatalogLowStockChip)) break;
      await this.session.scroll("up");
    }
    await this.session.waitForDisplayed(L.productCatalogLowStockChip, 12000);
    await this.session.tap(L.productCatalogLowStockChip, { timeout: 8000 });
    await this.session.pause(2000);
  }

  async verifyFilterCountUpdated(): Promise<void> {
    await this.session.pause(2500);
    const label = await this.session.getAttribute(L.productCatalogLowStockChip, "label");
    const match = label ? /\\((\\d+)\\)/.exec(label) : null;
    const newCount = match ? parseInt(match[1], 10) : -1;
    if (newCount < 0) throw new Error("Filter count badge not visible after product edit");
    if (newCount >= this._lastFilterCount && this._lastFilterCount >= 0) {
      throw new Error(\`Filter count did not decrease: was \${this._lastFilterCount}, now \${newCount}\`);
    }
  }
`.trim();

// ── Types ─────────────────────────────────────────────────────────────────

export interface FeatureCodegenInput {
  /** Jira ticket key, e.g. "SMB-1234" */
  ticketKey: string;
  /** One-line ticket summary */
  summary: string;
  /** Full acceptance criteria text */
  acceptanceCriteria: string;
  /** New locator IDs promoted from Swift in this PR (already in L map) */
  newLocatorIds: string[];
  /** Flow ID to use, e.g. "smb-1234-my-feature" */
  suggestedFlowId: string;
}

export interface FeatureCodegenResult {
  flowId: string;
  /** Generated TypeScript method bodies (to insert into FlowActions.ts) */
  actionMethods: string;
  /** Generated flow JSON object (to insert into inventory-flows.json) */
  flowJson: object;
  /** Generated FLOW_KEYWORDS entry (to insert into JiraPlanSynthesizer.ts) */
  keywordsEntry: string;
  /** Generated handler lines (to insert into AgentOrchestrator.ts handler map) */
  handlerLines: string;
  /** Names of generated action methods in order */
  actionNames: string[];
  /** Whether all four files were written */
  filesWritten: boolean;
  /** The module regression flow this ticket's steps were appended to */
  regressionFlowId?: string;
  /** Number of feature steps appended to the regression flow */
  regressionStepsAdded?: number;
}

// ── LLM client (reuses OPENAI_API_KEY; falls back to direct code templates) ──

function makeClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? new OpenAI({ apiKey: key }) : null;
}

async function callLLM(
  client: OpenAI,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    temperature: 0.15,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return res.choices[0]?.message?.content ?? "{}";
}

// ── Prompt builders ────────────────────────────────────────────────────────

function buildActionMethodsPrompt(input: FeatureCodegenInput): string {
  const locatorList = input.newLocatorIds
    .map((id) => `  ${toCamelKey(id)}: "${id.startsWith("~") ? id : `~${id}`}"`)
    .join("\n");

  return [
    `You are a senior iOS QA automation engineer writing Appium XCUITest automation for the Toast Operator app.`,
    ``,
    `Generate TypeScript async methods for the FlowActions class that test the following Jira ticket.`,
    ``,
    `Ticket: ${input.ticketKey} — ${input.summary}`,
    ``,
    `Acceptance Criteria:`,
    input.acceptanceCriteria.slice(0, 2000),
    ``,
    `New accessibility locators available in the L map (use these):`,
    locatorList || "  (none — use existing L map entries)",
    ``,
    `Rules:`,
    `- Each method is async and returns Promise<void>`,
    `- Use this.session.tap(), this.session.waitForDisplayed(), this.session.scroll(), this.session.getAttribute(), this.session.isDisplayed(), this.session.clearAndType(), this.session.pause()`,
    `- Use L.locatorKey for selectors — never hardcode strings unless no matching L entry exists`,
    `- this._lastFilterCount is a private field (number) you can use to store state between steps`,
    `- Throw a descriptive Error when an assertion fails`,
    `- Do NOT generate bootSimulator / launchApp / ensureLoggedIn / navigateToInventoryTab — these are setup steps`,
    `- Generate ONLY the steps needed to exercise the acceptance criteria`,
    `- Keep each method focused on one AC line`,
    ``,
    `Example methods for reference:`,
    FLOW_ACTION_EXAMPLE,
    ``,
    `Return JSON: { "methods": "<full TypeScript method bodies as a single string>", "methodNames": ["name1", "name2", ...] }`,
  ].join("\n");
}

function buildFlowJsonPrompt(
  input: FeatureCodegenInput,
  methodNames: string[],
): string {
  const setupSteps = [
    { id: "boot-simulator", action: "bootSimulator", description: "Start iOS Simulator" },
    { id: "launch-app", action: "launchApp", description: "Launch Toast Operator" },
    { id: "login", action: "ensureLoggedIn", description: "Sign in with QA account" },
    { id: "nav-inventory", action: "navigateToInventoryTab", description: "Navigate to Inventory tab" },
  ];

  return [
    `Generate an inventory-flows.json flow entry for this Jira ticket.`,
    ``,
    `Ticket: ${input.ticketKey} — ${input.summary}`,
    `Flow ID: ${input.suggestedFlowId}`,
    ``,
    `AC: ${input.acceptanceCriteria.slice(0, 1000)}`,
    ``,
    `Available action method names (generated for this ticket): ${methodNames.join(", ")}`,
    ``,
    `The flow must start with these 4 setup steps: ${JSON.stringify(setupSteps)}`,
    `Then add steps for each generated method in logical order.`,
    ``,
    `Return JSON: { "flow": { "id": "...", "name": "...", "aliases": [...], "module": "ToastUnifiedInventory", "entryTab": "Inventory", "sessionPolicy": "fresh", "steps": [...] } }`,
  ].join("\n");
}

function buildKeywordsPrompt(input: FeatureCodegenInput): string {
  return [
    `Generate a FLOW_KEYWORDS entry for JiraPlanSynthesizer.ts for this Jira ticket.`,
    ``,
    `Ticket: ${input.ticketKey} — ${input.summary}`,
    `Flow ID: ${input.suggestedFlowId}`,
    `AC: ${input.acceptanceCriteria.slice(0, 500)}`,
    ``,
    `Rules:`,
    `- Generate 4-7 regex patterns (as strings, no flags — flags will be added as /pattern/i at runtime)`,
    `- Patterns should match natural language variations of the ticket title and AC`,
    `- The command string is the human-readable agent command`,
    ``,
    `Return JSON: { "flowId": "...", "command": "Test <feature name>", "keywords": ["regex1", "regex2", ...] }`,
  ].join("\n");
}

// ── Template fallbacks (no LLM) ────────────────────────────────────────────

function templateActionMethods(input: FeatureCodegenInput): {
  methods: string;
  methodNames: string[];
} {
  const flowId = input.suggestedFlowId;
  const openName = `open${pascalCase(flowId)}`;
  const verifyName = `verify${pascalCase(flowId)}`;

  const methods = `
  async ${openName}(): Promise<void> {
    // Auto-generated for ${input.ticketKey}: ${input.summary}
    // TODO: replace with real navigation steps once UI is confirmed
    await this.session.pause(1000);
    const found = await this.session.waitForAnyDisplayed(
      [${input.newLocatorIds.slice(0, 3).map((id) => `L.${toCamelKey(id)}`).join(", ") || '"~product_catalog_header"'}],
      15000,
    );
    if (!found) throw new Error("${openName}: target screen not reached");
  }

  async ${verifyName}(): Promise<void> {
    // Auto-generated for ${input.ticketKey}
    await this.session.pause(1500);
    const visible = ${input.newLocatorIds.slice(0, 2).map((id) => `(await this.session.isDisplayed(L.${toCamelKey(id)}))`).join(" ||\n      ") || "true"};
    if (!visible) throw new Error("${verifyName}: expected elements not visible");
  }
`.trim();

  return { methods, methodNames: [openName, verifyName] };
}

// ── File writers ───────────────────────────────────────────────────────────

function insertIntoFlowActions(methods: string): void {
  const content = readFileSync(FLOW_ACTIONS_FILE, "utf-8");
  const block = `${FA_CODEGEN_START}\n  ${methods.split("\n").join("\n  ")}\n${FA_CODEGEN_END}`;

  let updated: string;
  if (content.includes(FA_CODEGEN_START)) {
    const si = content.indexOf(FA_CODEGEN_START);
    const ei = content.indexOf(FA_CODEGEN_END) + FA_CODEGEN_END.length;
    updated = content.slice(0, si) + block + content.slice(ei);
  } else {
    // Insert before the closing brace of the class
    const lastBrace = content.lastIndexOf("\n}");
    updated = content.slice(0, lastBrace) + "\n\n" + block + content.slice(lastBrace);
  }
  writeFileSync(FLOW_ACTIONS_FILE, updated, "utf-8");
}

function insertFlowJson(flowObj: object): void {
  const raw = readFileSync(FLOWS_JSON_FILE, "utf-8");
  const parsed = JSON.parse(raw) as { flows: object[] };

  const flowId = (flowObj as { id?: string }).id;
  const existing = parsed.flows.findIndex((f) => (f as { id?: string }).id === flowId);
  if (existing >= 0) {
    parsed.flows[existing] = flowObj;
  } else {
    parsed.flows.push(flowObj);
  }
  writeFileSync(FLOWS_JSON_FILE, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
}

function insertKeywordsEntry(entry: {
  flowId: string;
  command: string;
  keywords: string[];
}): void {
  const content = readFileSync(SYNTHESIZER_FILE, "utf-8");
  const marker = "const FLOW_KEYWORDS";
  const idx = content.indexOf(marker);
  if (idx === -1) return;

  // Check if entry already exists
  if (content.includes(`flowId: "${entry.flowId}"`)) {
    // Replace existing entry
    const entryStart = content.indexOf(`  {\n    flowId: "${entry.flowId}"`);
    if (entryStart === -1) return;
    const entryEnd = content.indexOf("\n  },\n", entryStart) + 5;
    const newEntry = buildKeywordsEntryCode(entry);
    writeFileSync(SYNTHESIZER_FILE, content.slice(0, entryStart) + newEntry + content.slice(entryEnd), "utf-8");
    return;
  }

  // Insert at top of array (highest priority)
  const arrayStart = content.indexOf("[", idx) + 1;
  const newEntry = "\n" + buildKeywordsEntryCode(entry) + ",";
  writeFileSync(SYNTHESIZER_FILE, content.slice(0, arrayStart) + newEntry + content.slice(arrayStart), "utf-8");
}

function buildKeywordsEntryCode(entry: {
  flowId: string;
  command: string;
  keywords: string[];
}): string {
  const regexes = entry.keywords
    .map((k) => `    /${k}/i,`)
    .join("\n");
  return `  {\n    flowId: "${entry.flowId}",\n    command: "${entry.command}",\n    keywords: [\n${regexes}\n    ],\n  }`;
}

function insertOrchestratorHandlers(
  handlerLines: string,
  methodNames: string[],
): void {
  const content = readFileSync(ORCHESTRATOR_FILE, "utf-8");

  // Build handler lines from method names if not provided
  const lines = handlerLines.trim() ||
    methodNames.map((n) => `      ${n}: () => actions.${n}(),`).join("\n");

  const block = `${ORC_CODEGEN_START}\n${lines}\n${ORC_CODEGEN_END}`;

  let updated: string;
  if (content.includes(ORC_CODEGEN_START)) {
    const si = content.indexOf(ORC_CODEGEN_START);
    const ei = content.indexOf(ORC_CODEGEN_END) + ORC_CODEGEN_END.length;
    updated = content.slice(0, si) + block + content.slice(ei);
  } else {
    // Insert before the closing of the handlers object
    const handlerClose = content.indexOf("    };\n\n    const handler = handlers");
    if (handlerClose === -1) {
      // Fallback: insert before last `};` in handlers block
      const fallback = content.lastIndexOf("      verifyCountingStyles");
      const lineEnd = content.indexOf("\n", fallback) + 1;
      updated = content.slice(0, lineEnd) + block + "\n" + content.slice(lineEnd);
    } else {
      updated = content.slice(0, handlerClose) + "    " + block + "\n" + content.slice(handlerClose);
    }
  }
  writeFileSync(ORCHESTRATOR_FILE, updated, "utf-8");
}

// ── Module detection + regression append ──────────────────────────────────

type InventoryModule = "cycle-count" | "invoice-scanning" | "product-catalog";

const MODULE_KEYWORDS: Array<{ module: InventoryModule; patterns: RegExp[] }> = [
  {
    module: "invoice-scanning",
    patterns: [
      /invoice/i, /scan.?bot/i, /upload.?invoice/i, /manage.?invoice/i,
      /landscape.*invoice/i, /low.?quality.*pop/i, /camera.*invoice/i,
    ],
  },
  {
    module: "product-catalog",
    patterns: [
      /product.?catalog/i, /catalog/i, /product.?detail/i, /low.?stock/i,
      /par.?max/i, /par.?min/i, /filter.?count/i, /plu/i, /barcode/i,
      /base.?price/i, /add.?product/i, /delete.?product/i, /edit.?product/i,
    ],
  },
  {
    module: "cycle-count",
    patterns: [
      /cycle.?count/i, /count.?sheet/i, /count.?unit/i, /unit.?selector/i,
      /counting/i, /inventory.?count/i,
    ],
  },
];

const REGRESSION_FLOW_ID: Record<InventoryModule, string> = {
  "cycle-count":       "cycle-count-smoke",
  "invoice-scanning":  "invoice-scanning-regression",
  "product-catalog":   "product-catalog-regression",
};

/** Detect which of the 3 modules a ticket belongs to from its summary + AC text. */
function detectModule(summary: string, acceptanceCriteria: string): InventoryModule {
  const corpus = `${summary}\n${acceptanceCriteria}`;
  let best: { module: InventoryModule; score: number } | null = null;
  for (const entry of MODULE_KEYWORDS) {
    const score = entry.patterns.filter((re) => re.test(corpus)).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { module: entry.module, score };
    }
  }
  return best?.module ?? "product-catalog";
}

interface FlowStep {
  id: string;
  action: string;
  description: string;
}
interface FlowEntry {
  id: string;
  steps: FlowStep[];
  [key: string]: unknown;
}

/**
 * Idempotently append the feature steps of a ticket flow into its module's
 * full regression flow. Uses a marker comment on each step object so
 * re-running for the same ticket replaces rather than duplicates.
 */
function appendToRegressionFlow(
  ticketKey: string,
  ticketFlowObj: object,
): { regressionFlowId: string; stepsAdded: number } {
  const raw = readFileSync(FLOWS_JSON_FILE, "utf-8");
  const parsed = JSON.parse(raw) as { flows: FlowEntry[] };

  const ticketFlow = ticketFlowObj as FlowEntry;

  // Detect module from the ticket flow's own steps' action names + descriptions
  const corpus = ticketFlow.steps.map((s) => `${s.action} ${s.description}`).join(" ");
  const module = detectModule(corpus, "");
  const regressionFlowId = REGRESSION_FLOW_ID[module];

  const regressionIdx = parsed.flows.findIndex((f) => f.id === regressionFlowId);
  if (regressionIdx === -1) {
    return { regressionFlowId, stepsAdded: 0 };
  }

  const regressionFlow = parsed.flows[regressionIdx];

  // The setup actions that live in every flow — never copy these
  const SETUP_ACTIONS = new Set([
    "bootSimulator", "launchApp", "ensureLoggedIn", "navigateToInventoryTab",
  ]);

  // Feature steps from the ticket flow (skip setup)
  const featureSteps = ticketFlow.steps.filter((s) => !SETUP_ACTIONS.has(s.action));
  if (featureSteps.length === 0) return { regressionFlowId, stepsAdded: 0 };

  // Remove any previously inserted steps for this ticket (idempotent)
  const marker = `ticket:${ticketKey}`;
  const withoutOld = regressionFlow.steps.filter(
    (s) => !(s as FlowStep & { _ticket?: string })._ticket?.includes(ticketKey),
  );

  // Tag each step with the ticket key so future runs can identify and replace them.
  // Strip any leading "[TICKET-KEY] " prefix from descriptions — step text should
  // read cleanly without ticket IDs in the UI.
  const taggedSteps = featureSteps.map((s) => ({
    ...s,
    id: `${ticketKey.toLowerCase()}-${s.id}`,
    description: s.description.replace(/^\[[A-Z]+-\d+\]\s*/i, ""),
    _ticket: marker,
  }));

  regressionFlow.steps = [...withoutOld, ...taggedSteps];
  parsed.flows[regressionIdx] = regressionFlow;
  writeFileSync(FLOWS_JSON_FILE, JSON.stringify(parsed, null, 2) + "\n", "utf-8");

  return { regressionFlowId, stepsAdded: taggedSteps.length };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toCamelKey(id: string): string {
  const bare = id.startsWith("~") ? id.slice(1) : id;
  return bare
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .split("_")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

function pascalCase(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

function slugToFlowId(summary: string, ticketKey: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${ticketKey.toLowerCase()}-${slug}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate and write all automation artifacts for a new feature.
 * Called automatically from copilot-merge-test.ts when new locators are detected.
 */
export async function generateFeatureCode(
  input: FeatureCodegenInput,
  opts: { dryRun?: boolean } = {},
): Promise<FeatureCodegenResult> {
  const client = makeClient();

  let methodsCode: string;
  let methodNames: string[];
  let flowObj: object;
  let keywordsEntry: { flowId: string; command: string; keywords: string[] };
  let handlerLines: string;

  // ── 1. Generate action methods ──────────────────────────────────────────
  if (client) {
    try {
      const raw = await callLLM(
        client,
        "You are a TypeScript/Appium QA engineer. Return valid JSON only.",
        buildActionMethodsPrompt(input),
      );
      const parsed = JSON.parse(raw) as { methods?: string; methodNames?: string[] };
      methodsCode = parsed.methods ?? "";
      methodNames = parsed.methodNames ?? [];
    } catch {
      const tmpl = templateActionMethods(input);
      methodsCode = tmpl.methods;
      methodNames = tmpl.methodNames;
    }
  } else {
    const tmpl = templateActionMethods(input);
    methodsCode = tmpl.methods;
    methodNames = tmpl.methodNames;
  }

  // ── 2. Generate flow JSON ───────────────────────────────────────────────
  if (client && methodNames.length > 0) {
    try {
      const raw = await callLLM(
        client,
        "You are a JSON configuration author for a QA test framework. Return valid JSON only.",
        buildFlowJsonPrompt(input, methodNames),
      );
      const parsed = JSON.parse(raw) as { flow?: object };
      flowObj = parsed.flow ?? buildTemplateFlow(input, methodNames);
    } catch {
      flowObj = buildTemplateFlow(input, methodNames);
    }
  } else {
    flowObj = buildTemplateFlow(input, methodNames);
  }

  // ── 3. Generate keywords entry ──────────────────────────────────────────
  if (client) {
    try {
      const raw = await callLLM(
        client,
        "You are a QA routing expert. Return valid JSON only.",
        buildKeywordsPrompt(input),
      );
      const parsed = JSON.parse(raw) as {
        flowId?: string;
        command?: string;
        keywords?: string[];
      };
      keywordsEntry = {
        flowId: parsed.flowId ?? input.suggestedFlowId,
        command: parsed.command ?? `Test ${input.summary}`,
        keywords: parsed.keywords ?? [input.summary.toLowerCase().replace(/\s+/g, ".")],
      };
    } catch {
      keywordsEntry = buildTemplateKeywords(input);
    }
  } else {
    keywordsEntry = buildTemplateKeywords(input);
  }

  // ── 4. Handler lines (deterministic from method names) ─────────────────
  handlerLines = methodNames
    .map((n) => `      ${n}: () => actions.${n}(),`)
    .join("\n");

  // ── Write to files ──────────────────────────────────────────────────────
  let filesWritten = false;
  let regressionFlowId: string | undefined;
  let regressionStepsAdded: number | undefined;

  if (!opts.dryRun) {
    try {
      if (methodsCode.trim()) insertIntoFlowActions(methodsCode);
      insertFlowJson(flowObj);
      insertKeywordsEntry(keywordsEntry);
      if (handlerLines) insertOrchestratorHandlers(handlerLines, methodNames);
      filesWritten = true;

      // Append the feature steps into the parent module's regression flow
      const regResult = appendToRegressionFlow(input.ticketKey, flowObj);
      regressionFlowId = regResult.regressionFlowId;
      regressionStepsAdded = regResult.stepsAdded;
    } catch (err) {
      console.error("[FeatureCodegen] File write failed:", err);
    }
  } else {
    // In dry-run, still report which regression flow would be updated
    const module = detectModule(input.summary, input.acceptanceCriteria);
    regressionFlowId = REGRESSION_FLOW_ID[module];
  }

  return {
    flowId: input.suggestedFlowId,
    actionMethods: methodsCode,
    flowJson: flowObj,
    keywordsEntry: buildKeywordsEntryCode(keywordsEntry),
    handlerLines,
    actionNames: methodNames,
    filesWritten,
    regressionFlowId,
    regressionStepsAdded,
  };
}

function buildTemplateFlow(
  input: FeatureCodegenInput,
  methodNames: string[],
): object {
  const setupSteps = [
    { id: "boot-simulator", action: "bootSimulator", description: "Start iOS Simulator" },
    { id: "launch-app", action: "launchApp", description: "Launch Toast Operator" },
    { id: "login", action: "ensureLoggedIn", description: "Sign in with QA account" },
    { id: "nav-inventory", action: "navigateToInventoryTab", description: "Navigate to Inventory tab" },
  ];
  const featureSteps = methodNames.map((name, i) => ({
    id: `step-${i + 1}-${name.replace(/([A-Z])/g, "-$1").toLowerCase()}`,
    action: name,
    description: `${input.ticketKey}: ${name}`,
  }));

  return {
    id: input.suggestedFlowId,
    name: input.summary,
    aliases: [
      `test ${input.summary.toLowerCase()}`,
      input.ticketKey.toLowerCase(),
    ],
    module: "ToastUnifiedInventory",
    entryTab: "Inventory",
    sessionPolicy: "fresh",
    steps: [...setupSteps, ...featureSteps],
  };
}

function buildTemplateKeywords(input: FeatureCodegenInput): {
  flowId: string;
  command: string;
  keywords: string[];
} {
  const words = input.summary
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const patterns = [
    words.slice(0, 3).join("."),
    input.ticketKey.toLowerCase().replace("-", "."),
  ].filter(Boolean);

  return {
    flowId: input.suggestedFlowId,
    command: `Test ${input.summary}`,
    keywords: patterns,
  };
}
