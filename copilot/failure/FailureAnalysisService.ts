import { OpenAIClient } from "../../agent/core/OpenAIClient.js";
import type { AgentRun, TestStep } from "../../agent/types.js";
import type { FailureAnalysis } from "../types.js";
import { clampConfidence } from "../confidence.js";

export class FailureAnalysisService {
  private readonly openai = new OpenAIClient();

  async analyze(
    run: AgentRun,
    failedStep: TestStep,
    error: string,
    pageSource?: string,
  ): Promise<FailureAnalysis> {
    const parsed = this.parseAssertion(error);
    const logExcerpt = run.logs.slice(-12).map((l) => `[${l.level}] ${l.message}`);
    const screenshotLabels = run.screenshots.slice(-3).map((s) => s.label);

    const offline = this.offlineAnalysis(run, failedStep, error, parsed, logExcerpt, pageSource);

    if (!this.openai.isAvailable) return offline;

    try {
      const narrative = await this.openai.explainFailure({
        command: run.command,
        step: `${failedStep.id}: ${failedStep.description}`,
        error,
        pageSourceSnippet: pageSource?.slice(0, 4000),
        healingAttempted: run.healingEvents.length > 0,
      });
      return {
        ...offline,
        possibleCause: this.extractCause(narrative) ?? offline.possibleCause,
        summary: narrative,
        confidencePercent: clampConfidence(offline.confidencePercent + 9),
      };
    } catch {
      return offline;
    }
  }

  private parseAssertion(error: string): Pick<FailureAnalysis, "expected" | "actual" | "assertion"> {
    const qtyMatch = error.match(/(?:expected|want)\s*[:=]?\s*(\d+).*?(?:actual|got|was)\s*[:=]?\s*(\d+)/i);
    if (qtyMatch) {
      return {
        assertion: "Inventory quantity validation failed",
        expected: qtyMatch[1],
        actual: qtyMatch[2],
      };
    }
    const visibleMatch = error.match(/not visible|not displayed|could not find|timeout/i);
    if (visibleMatch) {
      return { assertion: "UI element visibility assertion failed" };
    }
    return { assertion: error.split(":")[0]?.slice(0, 120) || "Step execution failed" };
  }

  private offlineAnalysis(
    run: AgentRun,
    step: TestStep,
    error: string,
    parsed: Pick<FailureAnalysis, "expected" | "actual" | "assertion">,
    logExcerpt: string[],
    pageSource?: string,
  ): FailureAnalysis {
    let possibleCause = "The UI state did not match the expected inventory workflow step.";
    let confidence = 68;

    if (parsed.assertion.includes("quantity")) {
      possibleCause =
        "Inventory cache may not have refreshed after the prior approval or count submission action.";
      confidence = 86;
    } else if (/StartCounting|CountSheet|Inventory/i.test(error)) {
      possibleCause =
        "Cycle count entry point may have changed, or the simulator session lost login/inventory permissions.";
      confidence = 82;
    } else if (/Save|primary_button|base_price/i.test(error)) {
      possibleCause =
        "Formatted currency input or disabled Save button blocked item edit completion.";
      confidence = 88;
    } else if (/logout|Confirm Log out/i.test(error)) {
      possibleCause = "Logout confirmation sheet or account scroll position differed from expected.";
      confidence = 84;
    } else if (/timeout|waitForDisplayed/i.test(error)) {
      possibleCause = "Element did not appear within the wait window — timing, scroll position, or selector drift.";
      confidence = 79;
    }

    if (parsed.expected && parsed.actual) confidence += 6;
    if (pageSource && pageSource.length > 500) confidence += 5;
    if (run.screenshots.length > 0) confidence += 4;
    if (logExcerpt.length >= 5) confidence += 3;
    if (run.healingEvents.length > 0) confidence += 2;

    return {
      assertion: parsed.assertion,
      expected: parsed.expected,
      actual: parsed.actual,
      possibleCause,
      confidencePercent: clampConfidence(confidence),
      summary: `Failure on "${step.description}": ${error}`,
      failedStepId: step.id,
      failedStepDescription: step.description,
      logExcerpt,
      screenshotLabels: [],
    };
  }

  private extractCause(narrative: string): string | undefined {
    const lines = narrative.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => l.length > 20 && l.length < 280);
  }
}
