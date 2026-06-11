import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentRun, TestStep } from "../../agent/types.js";
import type {
  ExecutiveIssue,
  ExecutiveSummaryReport,
  FailureAnalysis,
  PreflightResult,
  RiskLevel,
} from "../types.js";
import { clampConfidence, toConfidencePercent } from "../confidence.js";

export class ReportGenerator {
  buildExecutiveSummary(
    run: AgentRun,
    preflight?: PreflightResult,
    failureAnalyses: FailureAnalysis[] = [],
  ): ExecutiveSummaryReport {
    const steps = run.plan?.steps ?? [];
    const passed = steps.filter((s) => s.status === "passed" || s.status === "healed").length;
    const failed = steps.filter((s) => s.status === "failed").length;
    const generatedTests = preflight?.scenarios.length ?? steps.length;
    const feature = preflight?.featureAnalysis;
    const risk: RiskLevel = feature?.risk ?? (failed > 0 ? "Medium" : "Low");
    const confidence = this.computeExecutiveConfidence(
      run,
      preflight,
      passed,
      failed,
      steps.length,
      failureAnalyses,
    );

    const issues: ExecutiveIssue[] = failureAnalyses.map((f) => ({
      title: f.failedStepDescription ?? f.assertion,
      detail: f.assertion,
    }));

    for (const step of steps.filter((s) => s.status === "failed")) {
      if (issues.some((i) => i.title === step.description)) continue;
      issues.push({
        title: step.description,
        detail: step.error ?? run.failureExplanation ?? "Step failed without detail",
      });
    }

    const recommendation =
      failed === 0
        ? "Ship-ready for Unified Inventory smoke/regression covered by this run."
        : `Investigate ${issues.length} issue(s); re-run: ${preflight?.recommendedCommand ?? run.command}`;

    return {
      runId: run.id,
      featureName: feature?.featureName ?? run.plan?.flowName ?? run.command ?? "Unified Inventory QA",
      module: feature?.impactedModule ?? "ToastUnifiedInventory",
      generatedTests,
      passed,
      failed,
      issues,
      confidenceScore: confidence,
      risk,
      recommendation,
      exportedAt: new Date().toISOString(),
      command: run.command,
      status: run.status,
    };
  }

  persist(
    run: AgentRun,
    preflight: PreflightResult | undefined,
    reportsDir: string,
    failureAnalyses: FailureAnalysis[] = [],
  ): { jsonPath: string; htmlPath: string; summary: ExecutiveSummaryReport } {
    mkdirSync(reportsDir, { recursive: true });
    const summary = this.buildExecutiveSummary(run, preflight, failureAnalyses);

    const jsonPath = join(reportsDir, `${run.id}-executive-summary.json`);
    const htmlPath = join(reportsDir, `${run.id}-executive-summary.html`);
    const detailPath = join(reportsDir, `${run.id}-preflight.json`);

    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    writeFileSync(htmlPath, this.toHtml(summary, preflight, run));
    if (preflight) {
      writeFileSync(detailPath, JSON.stringify(preflight, null, 2));
    }

    return { jsonPath, htmlPath, summary };
  }

  private computeExecutiveConfidence(
    run: AgentRun,
    preflight: PreflightResult | undefined,
    _passed: number,
    failed: number,
    _totalSteps: number,
    _failureAnalyses: FailureAnalysis[],
  ): number {
    /** Same baseline as Feature Analysis — only reduce on failed/cancelled runs. */
    const base = toConfidencePercent(preflight?.featureAnalysis.confidenceScore, 85);

    if (failed > 0) {
      return clampConfidence(base - Math.min(28, failed * 10));
    }

    if (run.status === "failed") {
      return clampConfidence(base - 18);
    }

    if (run.status === "cancelled") {
      return clampConfidence(base - 10);
    }

    return base;
  }

  private toHtml(
    summary: ExecutiveSummaryReport,
    preflight: PreflightResult | undefined,
    run: AgentRun,
  ): string {
    const issues = summary.issues
      .map((i) => `<li><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.detail)}</p></li>`)
      .join("");
    const areas = (preflight?.featureAnalysis.impactedAreas ?? [])
      .map(
        (a) =>
          `<li>${escapeHtml(a.area)} — ${a.risk} risk (${escapeHtml(a.reason)})</li>`,
      )
      .join("");
    const steps = (run.plan?.steps ?? [])
      .map((s) => stepRow(s))
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>ToastPilot Executive Summary — ${escapeHtml(summary.runId)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0f14; color: #e8f0f8; padding: 2rem; max-width: 960px; margin: 0 auto; }
    h1 { color: #00ffc8; font-size: 1.5rem; }
    .metric { display: inline-block; margin: 0.5rem 1rem 0 0; padding: 0.5rem 1rem; border: 1px solid #334; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    td, th { border: 1px solid #334; padding: 0.5rem; text-align: left; }
    .pass { color: #6ee7a8; } .fail { color: #f87171; }
  </style>
</head>
<body>
  <h1>ToastPilot — Executive QA Summary</h1>
  <p><strong>Feature:</strong> ${escapeHtml(summary.featureName)} · <strong>Module:</strong> ${escapeHtml(summary.module)}</p>
  <p><strong>Command:</strong> ${escapeHtml(summary.command)}</p>
  <div>
    <span class="metric">Generated: ${summary.generatedTests}</span>
    <span class="metric">Passed: ${summary.passed}</span>
    <span class="metric">Failed: ${summary.failed}</span>
    <span class="metric">Risk: ${summary.risk}</span>
    <span class="metric">Confidence: ${toConfidencePercent(summary.confidenceScore)}%</span>
    <span class="metric">Status: ${escapeHtml(summary.status)}</span>
  </div>
  <h2>Recommendation</h2>
  <p>${escapeHtml(summary.recommendation)}</p>
  <h2>Impacted areas</h2>
  <ul>${areas || "<li>None detected in preflight</li>"}</ul>
  <h2>Issues</h2>
  <ul>${issues || "<li>None</li>"}</ul>
  <h2>Step results</h2>
  <table><thead><tr><th>Step</th><th>Status</th><th>Detail</th></tr></thead><tbody>${steps}</tbody></table>
  <p><small>Exported ${escapeHtml(summary.exportedAt)}</small></p>
</body>
</html>`;
  }
}

function stepRow(step: TestStep): string {
  const cls = step.status === "failed" ? "fail" : step.status === "passed" || step.status === "healed" ? "pass" : "";
  const detail = escapeHtml(step.error ?? step.description);
  return `<tr><td>${escapeHtml(step.id)}</td><td class="${cls}">${escapeHtml(step.status)}</td><td>${detail}</td></tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
