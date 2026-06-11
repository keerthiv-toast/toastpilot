/**
 * User-facing success copy keyed by inventory flow id (from inventory-flows.json).
 * Shared by AgentOrchestrator logs and the dashboard celebration UI / TTS.
 */

export interface FlowCompletionCopy {
  /** Short banner title (no "Congratulations"). */
  heading: string;
  /** Full success line for on-screen copy. */
  message: string;
  /** Spoken announcement (concise for TTS). */
  speech: string;
}

const SUCCESS_SPEECH = "All Tests Passed Successfully.";

const FLOW_COMPLETION: Record<string, FlowCompletionCopy> = {
  "upload-invoice": {
    heading: "Add / Upload invoice",
    message: "Add upload invoice flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "invoice-scanning": {
    heading: "Manage invoices",
    message: "Manage invoice flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "cycle-count": {
    heading: "Cycle count",
    message: "Cycle count flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "cycle-count-smoke": {
    heading: "Cycle count full regression",
    message: "Cycle count full regression completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "edit-item": {
    heading: "Edit item",
    message: "Edit item flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "add-new-item": {
    heading: "Add new item",
    message: "Add new item flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "add-item-location": {
    heading: "Add item location",
    message: "Add item location flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "minimal-smoke": {
    heading: "Minimal smoke",
    message: "Minimal smoke flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "login-only": {
    heading: "Login",
    message: "Login flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "logout-only": {
    heading: "Logout",
    message: "Logout flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "product-catalog": {
    heading: "Product catalog",
    message: "Product catalog flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "product-catalog-filters": {
    heading: "Product Catalog Filters",
    message: "Product Catalog filters flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "product-catalog-details": {
    heading: "Product Catalog Details",
    message: "Product Catalog details flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "product-catalog-add-edit-delete": {
    heading: "Product Catalog Add, Edit & Delete",
    message: "Product Catalog add, edit and delete flow completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "product-catalog-regression": {
    heading: "Product Catalog Full Regression",
    message: "Product Catalog full regression completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
  "post-submission-ui": {
    heading: "Post submission UI",
    message: "Post submission UI validation completed successfully. No failures.",
    speech: SUCCESS_SPEECH,
  },
};

function titleCaseWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function fallbackFromName(flowName?: string): FlowCompletionCopy {
  const raw = (flowName ?? "Flow").trim();
  const heading = titleCaseWords(raw.replace(/\s+only$/i, ""));
  const message = `${heading} flow completed successfully. No failures.`;
  return { heading, message, speech: SUCCESS_SPEECH };
}

function combinedCompletionCopy(flowId: string): FlowCompletionCopy | null {
  if (!flowId.includes("+")) return null;

  const ids = flowId.split("+").filter(Boolean);
  const headings = ids.map((id) => FLOW_COMPLETION[id]?.heading ?? titleCaseWords(id.replace(/-/g, " ")));
  const label = headings.join(", ");

  return {
    heading: "Combined test run",
    message: `${label} completed successfully. No failures.`,
    speech: SUCCESS_SPEECH,
  };
}

export function getFlowCompletionCopy(
  flowId?: string,
  flowName?: string,
): FlowCompletionCopy {
  const combined = flowId ? combinedCompletionCopy(flowId) : null;
  if (combined) return combined;

  if (flowId && FLOW_COMPLETION[flowId]) {
    return FLOW_COMPLETION[flowId];
  }
  return fallbackFromName(flowName);
}

/** Agent log line on pass (includes checkmark). */
export function completionSuccessLog(flowId?: string, flowName?: string): string {
  const { message } = getFlowCompletionCopy(flowId, flowName);
  return `✅ ${message}`;
}
