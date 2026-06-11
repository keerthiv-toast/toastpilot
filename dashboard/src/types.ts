export interface JiraContext {
  ticketKey: string;
  summary: string;
  description: string;
  acceptanceCriteria: string[];
  flowId: string;
  suggestedFlowIds: string[];
  rationale: string;
  labels: string[];
  components: string[];
  status: string;
  issueType: string;
  priority: string;
}

export type RunStatus =
  | "idle"
  | "planning"
  | "booting"
  | "running"
  | "healing"
  | "passed"
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "passed" | "failed" | "healed" | "skipped";

export interface TestStep {
  id: string;
  action: string;
  description: string;
  status: StepStatus;
  error?: string;
}

export interface TestPlan {
  id: string;
  flowName: string;
  command?: string;
  steps: TestStep[];
}

export interface LogEntry {
  id: string;
  level: string;
  message: string;
  timestamp: string;
}

export interface ScreenshotArtifact {
  stepId: string;
  label: string;
  base64Preview?: string;
}

export interface HealingEvent {
  stepId: string;
  originalSelector: string;
  healedSelector: string;
  strategy: string;
  aiReason?: string;
}

export interface FeatureAnalysisView {
  featureName: string;
  impactedModule: string;
  risk: string;
  changedFiles: string[];
  impactedAreas: Array<{ area: string; risk: string; reason: string }>;
  newWorkflows: string[];
  confidenceScore: number;
}

export interface GeneratedScenarioView {
  id: string;
  title: string;
  description?: string;
  category: string;
  mappedFlowId?: string;
  mappedAutomation?: string;
  automatable?: boolean;
  testCommand?: string;
  stepActions?: string[];
}

export interface FailureAnalysisView {
  assertion: string;
  expected?: string;
  actual?: string;
  possibleCause: string;
  confidencePercent: number;
  summary: string;
  logExcerpt?: string[];
  screenshotLabels?: string[];
}

export interface ExecutiveSummaryView {
  runId: string;
  featureName: string;
  module: string;
  generatedTests: number;
  passed: number;
  failed: number;
  issues: Array<{ title: string; detail: string }>;
  confidenceScore: number;
  risk: string;
  recommendation: string;
  exportedAt?: string;
  command?: string;
  status?: string;
}

export interface AgentRunState {
  id?: string;
  status: RunStatus;
  command: string;
  plan?: TestPlan;
  currentStepIndex: number;
  failureExplanation?: string;
  failureAnalysis?: FailureAnalysisView;
  executiveSummary?: ExecutiveSummaryView;
  healingEvents: HealingEvent[];
  screenshots: ScreenshotArtifact[];
  logs: LogEntry[];
  jiraContext?: JiraContext;
  videoPath?: string;
}

export interface CopilotDashboardState {
  featureAnalysis?: FeatureAnalysisView;
  scenarios: GeneratedScenarioView[];
  recommendedCommand: string;
  reasoning: string[];
}

export interface BugBashTicketResult {
  ticketKey: string;
  passed: boolean;
  runId: string;
  summary?: string;
  stepsPassed: number;
  stepsFailed: number;
  screenshotCount: number;
  hasVideo: boolean;
  failureExplanation?: string;
}

export type BugBashStatus = "idle" | "running" | "done" | "cancelled";

export interface BugBashState {
  status: BugBashStatus;
  sessionId?: string;
  tickets: string[];
  results: BugBashTicketResult[];
  currentIndex: number;
  currentTicket?: string;
}

export type AgentEvent =
  | { type: "history"; events: AgentEvent[] }
  | { type: "run:started"; run: { id: string; command: string; status: RunStatus; jiraContext?: JiraContext } }
  | { type: "run:status"; runId: string; status: RunStatus }
  | { type: "plan:generated"; runId: string; plan: TestPlan }
  | { type: "step:started"; runId: string; step: TestStep; index: number }
  | { type: "step:finished"; runId: string; step: TestStep; index: number }
  | { type: "step:healing"; runId: string; event: HealingEvent }
  | { type: "log"; runId: string; entry: LogEntry }
  | { type: "screenshot"; runId: string; artifact: ScreenshotArtifact }
  | { type: "failure:explained"; runId: string; explanation: string }
  | { type: "failure:analysis"; runId: string; analysis: FailureAnalysisView }
  | { type: "copilot:feature-analysis"; runId: string; analysis: FeatureAnalysisView }
  | { type: "copilot:scenarios"; runId: string; scenarios: GeneratedScenarioView[]; recommendedCommand: string }
  | { type: "copilot:reasoning"; runId: string; message: string; phase: string }
  | { type: "copilot:executive-summary"; runId: string; report: ExecutiveSummaryView }
  | { type: "run:finished"; run: { id: string; status: RunStatus; failureExplanation?: string; videoPath?: string } }
  | { type: "bugbash:started"; sessionId: string; tickets: string[] }
  | { type: "bugbash:ticket:started"; sessionId: string; ticketKey: string; index: number; total: number }
  | { type: "bugbash:ticket:finished"; sessionId: string; ticketKey: string; index: number; total: number; passed: boolean; runId: string }
  | { type: "bugbash:finished"; sessionId: string; results: BugBashTicketResult[] }
  | { type: "bugbash:cancelled"; sessionId: string };
