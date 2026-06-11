export type RiskLevel = "Low" | "Medium" | "High";

export interface ImpactedArea {
  area: string;
  module: string;
  risk: RiskLevel;
  reason: string;
  suggestedFlowIds: string[];
}

export interface GeneratedScenario {
  id: string;
  title: string;
  description?: string;
  category: "happy_path" | "negative" | "edge" | "role_based" | "permission";
  mappedFlowId?: string;
  mappedAutomation?: string;
  priority: number;
  automatable?: boolean;
  testCommand?: string;
  stepActions?: string[];
}

export interface FeatureAnalysis {
  id: string;
  analyzedAt: string;
  featureName: string;
  impactedModule: string;
  risk: RiskLevel;
  changedFiles: string[];
  impactedAreas: ImpactedArea[];
  newWorkflows: string[];
  prSummary?: string;
  confidenceScore: number;
}

export interface PreflightResult {
  featureAnalysis: FeatureAnalysis;
  scenarios: GeneratedScenario[];
  recommendedFlowIds: string[];
  recommendedCommand: string;
}

export interface FailureAnalysis {
  assertion: string;
  expected?: string;
  actual?: string;
  possibleCause: string;
  confidencePercent: number;
  summary: string;
  failedStepId?: string;
  failedStepDescription?: string;
  logExcerpt: string[];
  screenshotLabels: string[];
}

export interface ExecutiveIssue {
  title: string;
  detail: string;
}

export interface ExecutiveSummaryReport {
  runId: string;
  featureName: string;
  module: string;
  generatedTests: number;
  passed: number;
  failed: number;
  issues: ExecutiveIssue[];
  confidenceScore: number;
  risk: RiskLevel;
  recommendation: string;
  exportedAt: string;
  command: string;
  status: string;
}
