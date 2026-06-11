import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import type { TestPlan, TestStep } from "../types.js";
import type { JiraIssue } from "../../jira/JiraClient.js";

/** Thin OpenAI wrapper with graceful offline fallback for hackathon demos */
export class OpenAIClient {
  private client: OpenAI | null = null;

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    if (key?.trim()) {
      this.client = new OpenAI({ apiKey: key });
    }
  }

  get isAvailable(): boolean {
    return this.client !== null;
  }

  async generateTestPlan(command: string): Promise<TestPlan | null> {
    if (!this.client) return null;

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You generate mobile QA test plans for ToastUnifiedInventory Cycle Count in Toast Operator iOS app. Return JSON: { flowName, steps: [{ id, action, description }] }. Actions must be from: bootSimulator, launchApp, ensureLoggedIn, navigateToInventoryTab, verifyInventoryHome, selectCountSheet, startCounting, openFirstLocation, enterCountQuantity, submitLocationCount, validatePostSubmission, addItemLocation.",
        },
        { role: "user", content: command },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as {
        flowName: string;
        steps: Array<{ id: string; action: string; description: string }>;
      };
      const steps: TestStep[] = parsed.steps.map((s) => ({
        ...s,
        status: "pending" as const,
        logs: [],
      }));
      return {
        id: uuid(),
        flowId: "ai-generated",
        flowName: parsed.flowName,
        command,
        steps,
        createdAt: new Date().toISOString(),
        estimatedDurationSec: steps.length * 25,
      };
    } catch {
      return null;
    }
  }

  /**
   * Given a Jira issue, synthesise the best agent command and rationale.
   * Returns null when OpenAI is unavailable.
   */
  async synthesizeCommandFromJira(
    issue: JiraIssue,
  ): Promise<{ command: string; rationale: string } | null> {
    if (!this.client) return null;

    const availableFlows = [
      "product-catalog-regression", "product-catalog-add-edit-delete",
      "product-catalog-filters", "product-catalog-details", "product-catalog",
      "cycle-count-smoke", "cycle-count", "edit-item", "add-new-item",
      "add-item-location", "upload-invoice", "invoice-scanning",
      "login-only", "logout-only", "post-submission-ui", "minimal-smoke",
    ].join(", ");

    const prompt = [
      `You are a senior QA engineer for the Toast Operator iOS app, specifically the ToastUnifiedInventory module.`,
      `Given the following Jira ticket, determine the SINGLE best test command to run.`,
      ``,
      `Ticket: ${issue.key}`,
      `Summary: ${issue.summary}`,
      `Type: ${issue.issueType} | Priority: ${issue.priority} | Status: ${issue.status}`,
      `Labels: ${issue.labels.join(", ") || "none"}`,
      `Components: ${issue.components.join(", ") || "none"}`,
      ``,
      `Description:`,
      issue.description.slice(0, 1500),
      ``,
      `Acceptance Criteria:`,
      issue.acceptanceCriteria.slice(0, 1000),
      ``,
      `Available flow IDs: ${availableFlows}`,
      ``,
      `Rules:`,
      `- Map the ticket to ONE of the available flows above`,
      `- The command must be a natural language phrase that the agent understands`,
      `- Examples of valid commands:`,
      `    "Test Product Catalog entire flow"`,
      `    "Test Cycle Count full regression"`,
      `    "Test Product Catalog add edit delete"`,
      `    "Test upload invoice flow"`,
      `    "Test login flow"`,
      `- Only reference ToastUnifiedInventory features (no other Toast apps)`,
      `- Return JSON: { "command": "<agent command>", "flowId": "<matched flow id>", "rationale": "<1-2 sentence reason>" }`,
    ].join("\n");

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a QA automation expert for Toast Operator iOS. Always respond with valid JSON." },
        { role: "user", content: prompt },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as { command?: string; rationale?: string };
      if (!parsed.command) return null;
      return {
        command: parsed.command.trim(),
        rationale: parsed.rationale?.trim() ?? "AI-synthesised from Jira ticket content.",
      };
    } catch {
      return null;
    }
  }

  async explainFailure(context: {
    command: string;
    step: string;
    error: string;
    pageSourceSnippet?: string;
    healingAttempted?: boolean;
  }): Promise<string> {
    if (!this.client) {
      return this.offlineExplanation(context);
    }

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are a principal iOS QA engineer explaining test failures in plain English for ToastUnifiedInventory. Be concise (3-5 sentences), actionable, mention likely UI/accessibility causes.",
        },
        {
          role: "user",
          content: JSON.stringify(context, null, 2),
        },
      ],
    });

    return (
      response.choices[0]?.message?.content?.trim() ??
      this.offlineExplanation(context)
    );
  }

  private offlineExplanation(context: {
    step: string;
    error: string;
    healingAttempted?: boolean;
  }): string {
    if (context.healingAttempted) {
      return `The agent failed on step "${context.step}" even after self-healing selectors. ${context.error}. This often means the Toast Operator app build is missing, the simulator session expired, or inventory permissions/feature flags are disabled for the test account. Rebuild ToastOperator Dev, confirm opa-enable-unified-inventory, and verify the test user has quickEditInventoryQuantity or fullMenuEdit.`;
    }
    return `Step "${context.step}" could not complete: ${context.error}. The autonomous agent will retry with healed accessibility identifiers when the UI tree differs from expected (e.g. StartCountingButton vs legacy CountSheetNameView targets).`;
  }

  /**
   * Given a PR diff and Jira ticket, generate a custom flow composed entirely
   * from the existing action catalog. Returns null if OpenAI is unavailable.
   */
  async generateDynamicFlow(opts: {
    ticketKey: string;
    ticketSummary: string;
    ticketDescription: string;
    acceptanceCriteria: string[];
    prTitle: string;
    prDiff: string;
  }): Promise<{ flowName: string; rationale: string; steps: Array<{ id: string; action: string; description: string }> } | null> {
    if (!this.client) return null;

    // The complete catalog of actions the agent knows how to execute.
    // Every action returned by OpenAI MUST be in this list.
    const ACTION_CATALOG_ARRAY = [
      // Session setup (always required at start)
      "bootSimulator", "launchApp", "ensureLoggedIn",
      // Navigation
      "navigateToInventoryTab", "verifyInventoryHome",
      "tapAccountTab", "scrollAccountMenuToLogout", "tapLogout", "tapConfirmLogout", "finishLogoutFlow",
      // Cycle Count
      "selectCountSheet", "selectCountSheetRequired", "selectCountSheetOrCreateFromTemplate",
      "startCounting", "openFirstLocation", "backFromCountingToHome",
      "enterCountQuantity", "submitLocationCount", "submitCountSheet",
      "validatePostSubmission", "dismissCycleCountSubmissionSuccess",
      "addItemLocation", "tapKeepThemBlankButton",
      // Product Catalog — browse
      "openProductCatalog", "verifyProductCatalog", "verifyProductCatalogFilters",
      "backFromProductCatalogToHome", "tapCatalogViewAll",
      // Product Catalog — filters
      "openProductCatalogFilterSheet", "verifyProductCatalogSortByFilter",
      "verifyProductCatalogCategoryFilter", "verifyProductCatalogVendorFilter",
      "verifyProductCatalogWarningsFilter", "closeProductCatalogFilterSheet",
      "applyLowStockFilter", "captureFilterCount", "verifyFilterCountUpdated",
      "applyOutOfStockFilter", "verifyOutOfStockFilter",
      "applyNotSellingFilter", "verifyNotSellingFilter", "clearActiveFilters",
      // Product Catalog — item actions
      "openFirstProductDetails", "verifyProductInfoSection", "verifyInventorySection",
      "verifyOrdersSection", "verifyPricingAndCostsSection", "verifyDescriptionSection",
      "backToProductCatalog", "searchProductByName", "editProductInventoryFields",
      "expandVariantProduct", "verifyVariantExpansion",
      "tapAddProductButton", "enterProductName", "selectProductCategory",
      "enterProductBasePrice", "saveNewProduct", "editProductBasePrice",
      "editFirstFilteredProduct", "editItem", "editItemReadOnly",
      "addNewItem", "deleteProduct",
      // Invoice Scanning
      "tapManageInvoices", "openInvoiceManagement", "openFirstInvoiceWithChevron",
      "finishInvoiceScanView", "verifyInvoiceManagement", "backFromInvoiceToHome",
      "tapUploadInvoice", "acceptCameraPermissionAlert", "switchInvoiceCaptureToManual",
      "captureInvoicePhoto", "captureInvoicePhotoOnce",
      "dismissLowQualityInvoicePopupIfNeeded", "finishInvoiceUploadPreview",
      "tapInvoicePreviewEdit", "tapInvoiceAutoCrop", "tapInvoiceApply",
      "tapInvoiceNext", "tapInvoiceSubmit", "dismissInvoiceSubmissionSuccess",
      "verifyLowQualityPopupLandscape", "verifyLowQualityPopupVisible",
      "rotateToLandscape", "rotateToPortrait",
    ];
    const ACTION_CATALOG = ACTION_CATALOG_ARRAY.join(", ");

    const diffSnippet = opts.prDiff.length > 3000
      ? opts.prDiff.slice(0, 3000) + "\n...(diff truncated)"
      : opts.prDiff;

    const prompt = `You are a senior QA automation engineer for Toast Operator iOS — ToastUnifiedInventory module.

A developer has just merged a PR. Your job is to compose a targeted test flow for it using ONLY the existing action catalog below. Do NOT invent new action names.

## Jira Ticket
Key: ${opts.ticketKey}
Summary: ${opts.ticketSummary}
Description: ${opts.ticketDescription.slice(0, 800)}
Acceptance Criteria:
${opts.acceptanceCriteria.map((ac, i) => `  ${i + 1}. ${ac}`).join("\n")}

## PR Title
${opts.prTitle}

## PR Diff (Swift/TypeScript changes)
\`\`\`diff
${diffSnippet}
\`\`\`

## Available Action Catalog
${ACTION_CATALOG}

## Rules
1. Every flow MUST start with: bootSimulator → launchApp → ensureLoggedIn → navigateToInventoryTab → verifyInventoryHome
2. Every flow MUST end with: tapAccountTab → scrollAccountMenuToLogout → tapLogout → tapConfirmLogout → finishLogoutFlow
3. Between setup and teardown, include ONLY actions that exercise the changed/new functionality from the diff and acceptance criteria
4. When navigating AWAY from a pushed screen back to Inventory home, always include the appropriate back action BEFORE navigateToInventoryTab:
   - After Product Catalog steps → backFromProductCatalogToHome
   - After Cycle Count/location steps → backFromCountingToHome
   - After Invoice steps → backFromInvoiceToHome
5. Include 5–15 meaningful middle steps (not just setup/teardown)
6. Each step id must be kebab-case unique, e.g. "verify-product-filter-count"
7. Description must be a clear sentence explaining WHAT is being verified and WHY (reference the AC or diff change)
8. If the diff touches cycle-count Swift files → include cycle count actions
9. If the diff touches product-catalog Swift files → include product catalog actions
10. If the diff touches invoice Swift files → include invoice actions
11. If the diff is backend/infra only with no UI changes → return { "notTestable": true }

Return JSON exactly:
{
  "flowName": "string — human readable name for this test",
  "rationale": "string — 2 sentences why these steps cover the PR changes",
  "steps": [
    { "id": "kebab-case-id", "action": "actionFromCatalog", "description": "Clear description" }
  ]
}
OR if not UI-testable:
{ "notTestable": true, "reason": "string" }`;

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a QA automation expert for Toast Operator iOS. Respond with valid JSON only. Never invent action names outside the catalog provided." },
        { role: "user", content: prompt },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as {
        notTestable?: boolean;
        reason?: string;
        flowName?: string;
        rationale?: string;
        steps?: Array<{ id: string; action: string; description: string }>;
      };

      if (parsed.notTestable) {
        console.log(`[dynamic-flow] OpenAI says not UI-testable: ${parsed.reason ?? "no reason given"}`);
        return null;
      }

      if (!parsed.flowName || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;

      // Safety: filter out any hallucinated action names not in the catalog
      // Use the source array directly (not the joined string) and trim AI whitespace
      const catalogSet = new Set(ACTION_CATALOG_ARRAY);
      const safeSteps = parsed.steps
        .map((s) => ({ ...s, action: s.action?.trim() ?? "" }))
        .filter((s) => {
          if (!catalogSet.has(s.action)) {
            console.warn(`[dynamic-flow] Filtered hallucinated action: "${s.action}"`);
            return false;
          }
          return true;
        });

      if (safeSteps.length < 3) {
        console.warn(`[dynamic-flow] Too few valid steps after safety filter (${safeSteps.length}) — rejecting`);
        return null;
      }

      return {
        flowName: parsed.flowName,
        rationale: parsed.rationale ?? "AI-generated flow from PR diff and Jira ticket.",
        steps: safeSteps,
      };
    } catch {
      return null;
    }
  }
}
