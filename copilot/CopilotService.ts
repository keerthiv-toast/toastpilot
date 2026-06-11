import { existsSync, readFileSync } from "fs";
import type { AgentRun, TestStep } from "../agent/types.js";
import { ChangeDetector, type ChangeDetectionInput } from "./changeDetection/ChangeDetector.js";
import { FailureAnalysisService } from "./failure/FailureAnalysisService.js";
import { ReportGenerator } from "./reporting/ReportGenerator.js";
import type { ExecutiveSummaryReport, FailureAnalysis, PreflightResult } from "./types.js";

export type CopilotReasoningHandler = (message: string, phase: string) => void;

export class CopilotService {
  private readonly changeDetector = new ChangeDetector();
  private readonly failureAnalysis = new FailureAnalysisService();
  private readonly reportGenerator = new ReportGenerator();

  preflight(
    input: ChangeDetectionInput = {},
    onReasoning?: CopilotReasoningHandler,
  ): PreflightResult {
    const merged: ChangeDetectionInput = {
      ...input,
      prBody: input.prBody ?? this.loadOptionalFile(process.env.COPILOT_PR_BODY_FILE),
      jiraTicket: input.jiraTicket ?? process.env.COPILOT_JIRA_TICKET,
      commitMessage: input.commitMessage ?? process.env.COPILOT_COMMIT_MESSAGE,
      gitBase: input.gitBase ?? process.env.COPILOT_GIT_BASE,
    };

    onReasoning?.(
      merged.command?.trim()
        ? `Matching command to registered flows: "${merged.command.trim()}"…`
        : "Analyzing git diff for ToastUnifiedInventory…",
      "change_detection",
    );

    const result = this.changeDetector.preflight(merged);
    const { featureAnalysis, scenarios, recommendedFlowIds, recommendedCommand } = result;

    onReasoning?.(
      `Impacted areas: ${featureAnalysis.impactedAreas.map((a) => a.area).join(", ") || "none detected"}`,
      "impact_analysis",
    );
    onReasoning?.(`Generated ${scenarios.length} test scenarios`, "scenario_generation");
    onReasoning?.(`Area Risk: ${featureAnalysis.risk} · Flow match confidence: ${featureAnalysis.confidenceScore}%`, "risk_scoring");
    onReasoning?.(`Recommended command: ${recommendedCommand}`, "execution_plan");
    onReasoning?.(`Flow IDs: ${recommendedFlowIds.join(", ") || "minimal-smoke"}`, "flow_mapping");

    return result;
  }

  async analyzeFailure(
    run: AgentRun,
    failedStep: TestStep,
    error: string,
    pageSource?: string,
  ): Promise<FailureAnalysis> {
    return this.failureAnalysis.analyze(run, failedStep, error, pageSource);
  }

  buildExecutiveSummary(
    run: AgentRun,
    preflight?: PreflightResult,
    failureAnalyses: FailureAnalysis[] = [],
  ): ExecutiveSummaryReport {
    return this.reportGenerator.buildExecutiveSummary(run, preflight, failureAnalyses);
  }

  persistReports(
    run: AgentRun,
    preflight: PreflightResult | undefined,
    reportsDir: string,
    failureAnalyses: FailureAnalysis[] = [],
  ): string {
    const { jsonPath } = this.reportGenerator.persist(run, preflight, reportsDir, failureAnalyses);
    return jsonPath;
  }

  private loadOptionalFile(path?: string): string | undefined {
    if (!path || !existsSync(path)) return undefined;
    return readFileSync(path, "utf-8");
  }
}
