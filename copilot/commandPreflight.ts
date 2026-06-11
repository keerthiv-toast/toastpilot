import {
  expandedStepsForFlows,
  resolveFlowsFromCommand,
} from "../agent/core/TestPlanGenerator.js";
import { clampConfidence } from "./confidence.js";
import type {
  FeatureAnalysis,
  GeneratedScenario,
  ImpactedArea,
  PreflightResult,
  RiskLevel,
} from "./types.js";
import type { JiraContext } from "../agent/types.js";

const FLOW_AREA: Record<string, { area: string; risk: RiskLevel }> = {
  "login-only": { area: "Operator Login & Auth", risk: "Medium" },
  "logout-only": { area: "Account / Logout", risk: "Medium" },
  "minimal-smoke": { area: "Inventory Home", risk: "Medium" },
  "cycle-count": { area: "Cycle Count", risk: "High" },
  "cycle-count-smoke": { area: "Cycle Count", risk: "High" },
  "edit-item": { area: "Cycle Count", risk: "High" },
  "add-new-item": { area: "Cycle Count", risk: "High" },
  "add-item-location": { area: "Cycle Count", risk: "Medium" },
  "upload-invoice": { area: "Invoice Scanning", risk: "High" },
  "invoice-landscape-popup": { area: "Invoice Scanning", risk: "High" },
  "invoice-scanning": { area: "Invoice Scanning", risk: "High" },
  "product-catalog": { area: "Product Catalog", risk: "Medium" },
  "product-catalog-filters": { area: "Product Catalog", risk: "Medium" },
  "product-catalog-details": { area: "Product Catalog", risk: "Medium" },
  "product-catalog-add-edit-delete": { area: "Product Catalog", risk: "High" },
  "product-catalog-regression": { area: "Product Catalog", risk: "High" },
  "pc-filter-refresh": { area: "Product Catalog – PC Filters", risk: "High" },
  "post-submission-ui": { area: "Cycle Count", risk: "Medium" },
};

const AUTOMATABLE_FLOWS = new Set([
  "login-only", "logout-only", "minimal-smoke",
  "cycle-count", "cycle-count-smoke", "edit-item", "add-new-item", "add-item-location",
  "upload-invoice", "invoice-landscape-popup", "invoice-scanning",
  "product-catalog", "product-catalog-filters", "product-catalog-details",
  "product-catalog-add-edit-delete", "product-catalog-regression",
  "pc-filter-refresh",
  "post-submission-ui",
]);

function flowCommand(flowId: string): string {
  const COMMANDS: Record<string, string> = {
    "login-only": "Test login flow",
    "logout-only": "Test logout flow",
    "minimal-smoke": "Run inventory smoke test",
    "cycle-count": "Test Cycle Count inventory flow",
    "cycle-count-smoke": "Run full cycle count regression",
    "edit-item": "Test edit item on count sheet",
    "add-new-item": "Test add new item to count sheet",
    "add-item-location": "Test add item location",
    "upload-invoice": "Test upload invoice flow",
    "invoice-landscape-popup": "Test invoice landscape popup",
    "invoice-scanning": "Test invoice scanning",
    "product-catalog": "Test product catalog",
    "product-catalog-filters": "Test product catalog filters",
    "product-catalog-details": "Test product catalog details",
    "product-catalog-add-edit-delete": "Test product catalog add edit delete",
    "product-catalog-regression": "Run product catalog regression",
    "pc-filter-refresh": "Test PC filters refresh filter counts",
    "post-submission-ui": "Test post submission UI",
  };
  return COMMANDS[flowId] ?? `Test ${flowId}`;
}

const SETUP_STEPS = ["bootSimulator", "launchApp", "ensureLoggedIn", "navigateToInventoryTab"];

const SCENARIO_STEPS: Record<string, string[]> = {
  "invoice-portrait-capture": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "tapUploadInvoice", "acceptCameraPermissionAlert",
    "switchInvoiceCaptureToManual", "captureInvoicePhoto", "finishInvoiceUploadPreview",
  ],
  "invoice-landscape-popup": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "tapUploadInvoice", "acceptCameraPermissionAlert",
    "rotateToLandscape", "captureInvoicePhotoOnce", "captureInvoicePhotoOnce",
    "verifyLowQualityPopupVisible", "rotateToPortrait", "dismissLowQualityInvoicePopupIfNeeded",
  ],
  "invoice-low-quality-popup": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "tapUploadInvoice", "acceptCameraPermissionAlert",
    "captureInvoicePhotoOnce", "captureInvoicePhotoOnce", "verifyLowQualityPopupVisible",
    "dismissLowQualityInvoicePopupIfNeeded",
  ],
  "invoice-submit-full": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "tapUploadInvoice", "acceptCameraPermissionAlert",
    "switchInvoiceCaptureToManual", "captureInvoicePhoto", "finishInvoiceUploadPreview",
    "tapInvoicePreviewEdit", "tapInvoiceAutoCrop", "tapInvoiceApply",
    "tapInvoiceNext", "tapInvoiceSubmit", "dismissInvoiceSubmissionSuccess",
  ],
  "login-happy": [
    ...SETUP_STEPS, "verifyInventoryHome",
  ],
  "cycle-count-happy": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "selectCountSheetRequired", "startCounting",
    "openFirstLocation", "enterCountQuantity", "submitLocationCount",
    "tapKeepThemBlankButton", "submitCountSheet", "validatePostSubmission",
    "dismissCycleCountSubmissionSuccess",
  ],
  "cycle-count-add-location": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "selectCountSheet", "startCounting", "addItemLocation",
  ],
  "product-catalog-happy": [
    ...SETUP_STEPS,
    "openProductCatalog", "verifyProductCatalog", "verifyProductCatalogFilters",
  ],
  "pc-filter-refresh": [
    ...SETUP_STEPS,
    "openProductCatalog", "verifyProductCatalog",
    "applyLowStockFilter", "captureFilterCount",
    "editFirstFilteredProduct", "verifyFilterCountUpdated",
  ],
  "invoice-manage": [
    ...SETUP_STEPS,
    "verifyInventoryHome", "tapManageInvoices", "openFirstInvoiceWithChevron", "finishInvoiceScanView",
  ],
};

function stepsForScenario(scenarioKey: string): string[] | undefined {
  return SCENARIO_STEPS[scenarioKey];
}

function scenarioStepsForFlow(flowId: string, scenarioKey: string): string[] | undefined {
  return stepsForScenario(scenarioKey) ?? stepsForScenario(flowId);
}

/** Map each AC line to a positive test scenario. */
function acToPositiveScenario(ac: string, index: number, flowId: string): GeneratedScenario {
  const clean = ac.replace(/^[-*•]\s*/, "").trim();
  const canAutomate = AUTOMATABLE_FLOWS.has(flowId);
  const scenarioKey = flowId === "invoice-landscape-popup" ? "invoice-landscape-popup" : flowId;
  const steps = canAutomate ? scenarioStepsForFlow(flowId, scenarioKey) : undefined;
  return {
    id: `ac-pos-${index + 1}`,
    title: `[Positive] ${clean}`,
    description: `Verify the acceptance criterion is met: "${clean}"`,
    category: "happy_path",
    mappedFlowId: flowId,
    priority: index + 1,
    automatable: canAutomate,
    testCommand: canAutomate ? flowCommand(flowId) : undefined,
    stepActions: steps,
  };
}

/** Derive a negative scenario by inverting or stress-testing an AC line. */
function acToNegativeScenario(ac: string, index: number, flowId: string): GeneratedScenario | null {
  const clean = ac.replace(/^[-*•]\s*/, "").trim().toLowerCase();
  const canAutomate = AUTOMATABLE_FLOWS.has(flowId);
  const base = { mappedFlowId: flowId, priority: 100 + index, category: "negative" as const };

  if (clean.includes("filter") && (clean.includes("refresh") || clean.includes("instant") || clean.includes("count") || clean.includes("update"))) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] Filter count stale — does NOT update without pull-to-refresh`,
      description: `Edit a product, return to catalog, and verify that if the filter count did NOT update, a pull-to-refresh corrects it (regression guard for the AC fix).`,
      ...base,
      automatable: canAutomate,
      testCommand: canAutomate ? flowCommand(flowId) : undefined,
      stepActions: canAutomate ? stepsForScenario("pc-filter-refresh") : undefined,
    };
  }
  if (clean.includes("landscape") || clean.includes("orientation")) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] Modal truncated in landscape — text and button clipped`,
      description: `Rotate to landscape and verify the modal does NOT clip or truncate the error message or the action button.`,
      ...base,
      automatable: canAutomate,
      testCommand: canAutomate ? flowCommand(flowId) : undefined,
      stepActions: canAutomate ? stepsForScenario("invoice-landscape-popup") : undefined,
    };
  }
  if (clean.includes("max width") || clean.includes("width")) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] Modal exceeds max width constraint`,
      description: `Verify that the modal does not overflow or stretch beyond the defined max width on any screen size.`,
      ...base,
      automatable: canAutomate,
      testCommand: canAutomate ? flowCommand(flowId) : undefined,
      stepActions: canAutomate ? stepsForScenario("invoice-landscape-popup") : undefined,
    };
  }
  if (clean.includes("popup") || clean.includes("modal") || clean.includes("alert")) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] Popup fails to appear after trigger action`,
      description: `Perform the trigger action and verify the popup appears. Then verify dismissing it and re-triggering shows it again correctly.`,
      ...base,
      automatable: canAutomate,
      testCommand: canAutomate ? flowCommand(flowId) : undefined,
      stepActions: canAutomate ? stepsForScenario("invoice-low-quality-popup") : undefined,
    };
  }
  if (clean.includes("button") || clean.includes("tap") || clean.includes("click")) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] Button unresponsive or hidden in non-standard state`,
      description: `Verify the button remains tappable and visible when the app is in background/foreground transition or low memory state.`,
      ...base,
      automatable: false,
    };
  }
  if (clean.includes("image") || clean.includes("photo") || clean.includes("camera")) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] Camera permission denied — graceful error shown`,
      description: `Deny camera permission and verify the app shows a helpful error instead of crashing or showing a blank screen.`,
      ...base,
      automatable: false,
    };
  }
  if (clean.includes("quality") || clean.includes("low") || clean.includes("poor")) {
    return {
      id: `ac-neg-${index + 1}`,
      title: `[Negative] High-quality image does not trigger low-quality popup`,
      description: `Capture a clear, well-lit image and confirm the low-quality popup does NOT appear — only triggered for genuinely poor images.`,
      ...base,
      automatable: canAutomate,
      testCommand: canAutomate ? flowCommand(flowId) : undefined,
    };
  }
  return null;
}

/** Edge case scenarios derived from the command and area. */
function buildEdgeScenarios(
  command: string,
  flowIds: string[],
  jiraContext: JiraContext | undefined,
): GeneratedScenario[] {
  const cmd = command.toLowerCase();
  const area = flowIds[0] ?? "";
  const edge: GeneratedScenario[] = [];
  const canAutomate = AUTOMATABLE_FLOWS.has(area);
  const cmd0 = canAutomate ? flowCommand(area) : undefined;

  if (area.includes("invoice") || cmd.includes("invoice") || cmd.includes("landscape")) {
    edge.push(
      {
        id: "edge-1",
        title: `[Edge] Rapid orientation flip during popup display`,
        description: `Rotate device portrait → landscape → portrait quickly while the popup is visible. Verify layout recovers correctly with no visual artifacts.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 200,
        automatable: canAutomate,
        testCommand: cmd0,
      },
      {
        id: "edge-2",
        title: `[Edge] Popup visible while keyboard is open`,
        description: `Trigger the popup when a text field is active and the keyboard is showing. Verify the popup is not obscured by the keyboard.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 201,
        automatable: false,
      },
      {
        id: "edge-3",
        title: `[Edge] Network lost mid-capture`,
        description: `Disable network after opening the camera screen but before confirming the capture. Verify the app handles the error gracefully.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 202,
        automatable: false,
      },
    );
  }

  const isCycleCountCmd = area.includes("cycle-count") || cmd.includes("cycle count") || cmd.includes("cycle_count") || (cmd.includes("demo") && cmd.includes("failure"));
  if (isCycleCountCmd) {
    edge.push(
      {
        id: "edge-1",
        title: `[Edge] Count sheet with zero items`,
        description: `Open a count sheet that has no items and verify the empty state is displayed correctly without crashing.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 200,
        automatable: false,
      },
      {
        id: "edge-2",
        title: `[Edge] Submit count with all items at zero quantity`,
        description: `Enter 0 for all item quantities and submit. Verify the system accepts this and reflects zeroed inventory correctly.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 201,
        automatable: false,
      },
    );
  }

  if (area.includes("pc-filter-refresh") || (cmd.includes("filter") && (cmd.includes("refresh") || cmd.includes("instant") || cmd.includes("count")))) {
    edge.push(
      {
        id: "edge-1",
        title: `[Edge] Filter count updates after toggling product selling status`,
        description: `Mark a low-stock product as 'Not selling' and verify the Low stock filter count decreases automatically without pull-to-refresh.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 200,
        automatable: false,
      },
      {
        id: "edge-2",
        title: `[Edge] Filter remains active after returning from product details`,
        description: `Navigate into a product's detail page, press back, and verify the Low stock filter chip is still selected and the filtered list is intact.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 201,
        automatable: canAutomate,
        testCommand: cmd0,
        stepActions: canAutomate ? stepsForScenario("pc-filter-refresh") : undefined,
      },
      {
        id: "edge-3",
        title: `[Edge] Pull-to-refresh not required — instant update`,
        description: `After editing a product, do NOT pull-to-refresh. Verify the filter count reflects the change within 3 seconds of returning to the catalog.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 202,
        automatable: canAutomate,
        testCommand: cmd0,
        stepActions: canAutomate ? stepsForScenario("pc-filter-refresh") : undefined,
      },
    );
  }

  if (area.includes("product-catalog") || cmd.includes("product") || cmd.includes("catalog")) {
    edge.push(
      {
        id: "edge-1",
        title: `[Edge] Product with extremely long name wraps correctly`,
        description: `Verify that a product name with 100+ characters wraps or truncates gracefully in all list and detail views.`,
        category: "edge",
        mappedFlowId: flowIds[0],
        priority: 200,
        automatable: false,
      },
    );
  }

  if (jiraContext?.priority === "High" || jiraContext?.priority === "Highest") {
    edge.push({
      id: "edge-regression",
      title: `[Edge] Regression — feature stable after app restart`,
      description: `Force-quit and relaunch the app. Navigate back to the tested feature and confirm state is consistent with the last interaction.`,
      category: "edge",
      mappedFlowId: flowIds[0],
      priority: 203,
      automatable: canAutomate,
      testCommand: cmd0,
    });
  }

  return edge;
}

/** Build scenarios from Jira AC lines + command context. */
function buildJiraScenarios(
  command: string,
  flowIds: string[],
  jiraContext: JiraContext,
): GeneratedScenario[] {
  const primaryFlowId = flowIds[0] ?? "minimal-smoke";
  const scenarios: GeneratedScenario[] = [];

  const acLines = jiraContext.acceptanceCriteria.filter((l) => l.trim().length > 0);

  if (acLines.length > 0) {
    acLines.forEach((ac, i) => {
      scenarios.push(acToPositiveScenario(ac, i, primaryFlowId));
    });

    acLines.forEach((ac, i) => {
      const neg = acToNegativeScenario(ac, i, primaryFlowId);
      if (neg) scenarios.push(neg);
    });
  } else {
    const canAutomate = AUTOMATABLE_FLOWS.has(primaryFlowId);
    scenarios.push({
      id: "pos-1",
      title: `[Positive] ${jiraContext.summary} — happy path`,
      description: `Execute the main flow described in ${jiraContext.ticketKey}: "${jiraContext.summary}"`,
      category: "happy_path",
      mappedFlowId: primaryFlowId,
      priority: 1,
      automatable: canAutomate,
      testCommand: canAutomate ? flowCommand(primaryFlowId) : undefined,
    });
    scenarios.push({
      id: "neg-1",
      title: `[Negative] Feature fails gracefully under error condition`,
      description: `Simulate an error state (network failure, invalid input) and verify the app recovers without crashing.`,
      category: "negative",
      mappedFlowId: primaryFlowId,
      priority: 101,
      automatable: false,
    });
  }

  const edgeScenarios = buildEdgeScenarios(command, flowIds, jiraContext);
  scenarios.push(...edgeScenarios);

  return scenarios.sort((a, b) => a.priority - b.priority);
}

/** Build generic positive/negative/edge scenarios from command text alone (no Jira). */
function buildCommandScenarios(command: string, flowIds: string[]): GeneratedScenario[] {
  const primaryFlowId = flowIds[0] ?? "minimal-smoke";
  const cmd = command.toLowerCase();
  const scenarios: GeneratedScenario[] = [];
  const canAutomate = AUTOMATABLE_FLOWS.has(primaryFlowId);
  const testCmd = canAutomate ? flowCommand(primaryFlowId) : undefined;

  scenarios.push({
    id: "pos-1",
    title: `[Positive] ${command} — complete flow succeeds`,
    description: `Execute "${command}" end-to-end and verify all steps pass with no errors.`,
    category: "happy_path",
    mappedFlowId: primaryFlowId,
    priority: 1,
    automatable: canAutomate,
    testCommand: testCmd,
    stepActions: canAutomate ? stepsForScenario(primaryFlowId) : undefined,
  });

  if (cmd.includes("login") || cmd.includes("sign in") || cmd.includes("auth")) {
    scenarios.push(
      {
        id: "pos-2",
        title: `[Positive] Login with valid credentials reaches Inventory home`,
        description: `Sign in with the QA test account and verify the Inventory tab is accessible within 60 seconds.`,
        category: "happy_path",
        mappedFlowId: primaryFlowId,
        priority: 2,
        automatable: canAutomate,
        testCommand: testCmd,
        stepActions: canAutomate ? stepsForScenario("login-happy") : undefined,
      },
      {
        id: "neg-1",
        title: `[Negative] Login with invalid password shows error`,
        description: `Enter a wrong password and verify an appropriate error message is shown without crashing.`,
        category: "negative",
        mappedFlowId: primaryFlowId,
        priority: 101,
        automatable: false,
      },
      {
        id: "edge-1",
        title: `[Edge] Session expiry — re-login flow`,
        description: `Simulate session expiry and verify the user is prompted to re-authenticate without data loss.`,
        category: "edge",
        mappedFlowId: primaryFlowId,
        priority: 201,
        automatable: false,
      },
    );
  } else if (cmd.includes("cycle count") || cmd.includes("count") || (cmd.includes("demo") && cmd.includes("failure"))) {
    scenarios.push(
      {
        id: "pos-2",
        title: `[Positive] Count sheet loads with correct items`,
        description: `Open a cycle count and verify all expected items and quantities are displayed.`,
        category: "happy_path",
        mappedFlowId: primaryFlowId,
        priority: 2,
        automatable: canAutomate,
        testCommand: testCmd,
        stepActions: canAutomate ? stepsForScenario("cycle-count-happy") : undefined,
      },
      {
        id: "neg-1",
        title: `[Negative] Submit count without entering quantities`,
        description: `Attempt to submit a count sheet with empty quantity fields and verify validation prevents submission.`,
        category: "negative",
        mappedFlowId: primaryFlowId,
        priority: 101,
        automatable: false,
      },
    );
  } else if (
    primaryFlowId === "pc-filter-refresh" ||
    (cmd.includes("filter") && (cmd.includes("refresh") || cmd.includes("count") || cmd.includes("instant")))
  ) {
    scenarios.push(
      {
        id: "pos-2",
        title: `[Positive] Filter count updates instantly after product base price edit`,
        description: `Apply the Low stock filter, edit a product's base price, return to the catalog (no pull-to-refresh), and verify the filter count on the chip reflects the change.`,
        category: "happy_path",
        mappedFlowId: primaryFlowId,
        priority: 2,
        automatable: canAutomate,
        testCommand: testCmd,
        stepActions: canAutomate ? stepsForScenario("pc-filter-refresh") : undefined,
      },
      {
        id: "neg-1",
        title: `[Negative] Filter count stale without pull-to-refresh (regression guard)`,
        description: `Edit a product and verify that returning to the catalog WITHOUT pulling to refresh shows the updated count. If the count is stale, the AC is not met.`,
        category: "negative",
        mappedFlowId: primaryFlowId,
        priority: 101,
        automatable: canAutomate,
        testCommand: testCmd,
        stepActions: canAutomate ? stepsForScenario("pc-filter-refresh") : undefined,
      },
      {
        id: "edge-1",
        title: `[Edge] Simultaneous filter + product edit from another session`,
        description: `Edit a product on one device and verify the filter count on a second device updates automatically (tests real-time sync behavior).`,
        category: "edge",
        mappedFlowId: primaryFlowId,
        priority: 201,
        automatable: false,
      },
    );
  } else if (cmd.includes("invoice") || cmd.includes("landscape") || cmd.includes("popup")) {
    scenarios.push(
      {
        id: "pos-2",
        title: `[Positive] Invoice capture succeeds in portrait mode`,
        description: `Capture an invoice image in portrait orientation and verify it processes successfully.`,
        category: "happy_path",
        mappedFlowId: "upload-invoice",
        priority: 2,
        automatable: true,
        testCommand: flowCommand("upload-invoice"),
        stepActions: stepsForScenario("invoice-portrait-capture"),
      },
      {
        id: "neg-1",
        title: `[Negative] Low-quality image triggers popup with full message visible`,
        description: `Capture a poor-quality image and verify the low-quality warning popup appears with the complete error message and action button visible.`,
        category: "negative",
        mappedFlowId: primaryFlowId,
        priority: 101,
        automatable: canAutomate,
        testCommand: testCmd,
        stepActions: canAutomate ? stepsForScenario("invoice-low-quality-popup") : undefined,
      },
      {
        id: "edge-1",
        title: `[Edge] Popup layout correct in landscape orientation`,
        description: `Rotate to landscape and capture a low-quality image. Verify the popup is not clipped and max width constraint is respected.`,
        category: "edge",
        mappedFlowId: primaryFlowId,
        priority: 201,
        automatable: canAutomate,
        testCommand: testCmd,
        stepActions: canAutomate ? stepsForScenario("invoice-landscape-popup") : undefined,
      },
    );
  } else {
    scenarios.push(
      {
        id: "neg-1",
        title: `[Negative] Flow interrupted mid-way — graceful recovery`,
        description: `Interrupt the flow mid-execution (background app, network toggle) and verify the app recovers or shows a helpful error.`,
        category: "negative",
        mappedFlowId: primaryFlowId,
        priority: 101,
        automatable: false,
      },
      {
        id: "edge-1",
        title: `[Edge] Feature state consistent after app restart`,
        description: `Force-quit and relaunch. Navigate to the feature and verify state is correct.`,
        category: "edge",
        mappedFlowId: primaryFlowId,
        priority: 201,
        automatable: canAutomate,
        testCommand: testCmd,
      },
    );
  }

  const edgeScenarios = buildEdgeScenarios(command, flowIds, undefined);
  const existingIds = new Set(scenarios.map((s) => s.id));
  scenarios.push(...edgeScenarios.filter((s) => !existingIds.has(s.id)));

  return scenarios.sort((a, b) => a.priority - b.priority);
}

export function buildCommandAlignedPreflight(
  command: string,
  jiraContext?: JiraContext,
): PreflightResult | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const flows = resolveFlowsFromCommand(trimmed);
  if (flows.length === 0) return null;

  const flowIds = flows.map((f) => f.id);

  const scenarios: GeneratedScenario[] = jiraContext
    ? buildJiraScenarios(trimmed, flowIds, jiraContext)
    : buildCommandScenarios(trimmed, flowIds);

  const impactedAreas: ImpactedArea[] = flows.map((flow) => {
    const meta = FLOW_AREA[flow.id] ?? { area: flow.name, risk: "Medium" as RiskLevel };
    return {
      area: meta.area,
      module: "ToastUnifiedInventory",
      risk: meta.risk,
      reason: `Matched agent command to flow "${flow.name}" (${flow.id})`,
      suggestedFlowIds: [flow.id],
    };
  });

  const risk: RiskLevel = impactedAreas.some((a) => a.risk === "High")
    ? "High"
    : impactedAreas.some((a) => a.risk === "Medium")
      ? "Medium"
      : "Low";

  const featureName =
    flows.length === 1 ? flows[0].name : flows.map((f) => f.name).join(" + ");

  const featureAnalysis: FeatureAnalysis = {
    id: `feature-cmd-${Date.now()}`,
    analyzedAt: new Date().toISOString(),
    featureName,
    impactedModule: "ToastUnifiedInventory",
    risk,
    changedFiles: [],
    impactedAreas,
    newWorkflows: scenarios.map((s) => s.title),
    confidenceScore: clampConfidence(88 + flows.length * 4 + scenarios.length * 2),
  };

  return {
    featureAnalysis,
    scenarios,
    recommendedFlowIds: flowIds,
    recommendedCommand: trimmed,
  };
}
