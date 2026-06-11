/** Jira ticket context attached to a run triggered from a Jira ticket. */
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
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  healedSelector?: string;
  screenshotPath?: string;
  logs: string[];
}

export interface TestPlan {
  id: string;
  flowId: string;
  /** Present when the plan merges multiple flows (command used `and`). */
  flowIds?: string[];
  flowName: string;
  command: string;
  steps: TestStep[];
  /**
   * "fresh": start from logged-out welcome/login state (new Appium session, app reset)
   * "reuse": keep the current Appium session/app state (skip login if already logged in)
   */
  sessionPolicy?: "fresh" | "reuse";
  createdAt: string;
  estimatedDurationSec: number;
}

export interface AgentRun {
  id: string;
  status: RunStatus;
  command: string;
  plan?: TestPlan;
  currentStepIndex: number;
  startedAt?: string;
  finishedAt?: string;
  failureExplanation?: string;
  failureAnalysis?: Record<string, unknown>;
  executiveSummary?: Record<string, unknown>;
  healingEvents: HealingEvent[];
  screenshots: ScreenshotArtifact[];
  logs: LogEntry[];
  /** Path to the recorded .mp4 of the full simulator run */
  videoPath?: string;
  /** Present when the run was initiated from a Jira ticket. */
  jiraContext?: JiraContext;
  /** When set, only steps whose action matches an entry in this list are executed. */
  stepActions?: string[];
}

export interface HealingEvent {
  id: string;
  stepId: string;
  originalSelector: string;
  healedSelector: string;
  strategy: string;
  timestamp: string;
  aiReason?: string;
}

export interface ScreenshotArtifact {
  id: string;
  stepId: string;
  label: string;
  path: string;
  base64Preview?: string;
  timestamp: string;
}

export interface LogEntry {
  id: string;
  level: "info" | "warn" | "error" | "success" | "agent";
  message: string;
  timestamp: string;
  stepId?: string;
}

export type AgentEvent =
  | { type: "run:started"; run: AgentRun }
  | { type: "run:status"; runId: string; status: RunStatus }
  | { type: "plan:generated"; runId: string; plan: TestPlan }
  | { type: "step:started"; runId: string; step: TestStep; index: number }
  | { type: "step:finished"; runId: string; step: TestStep; index: number }
  | { type: "step:healing"; runId: string; event: HealingEvent }
  | { type: "log"; runId: string; entry: LogEntry }
  | { type: "screenshot"; runId: string; artifact: ScreenshotArtifact }
  | { type: "failure:explained"; runId: string; explanation: string }
  | { type: "failure:analysis"; runId: string; analysis: Record<string, unknown> }
  | { type: "copilot:feature-analysis"; runId: string; analysis: Record<string, unknown> }
  | { type: "copilot:scenarios"; runId: string; scenarios: unknown[]; recommendedCommand: string }
  | { type: "copilot:reasoning"; runId: string; message: string; phase: string }
  | { type: "copilot:executive-summary"; runId: string; report: Record<string, unknown> }
  | { type: "run:finished"; run: AgentRun }
  | { type: "bugbash:started"; sessionId: string; tickets: string[] }
  | { type: "bugbash:ticket:started"; sessionId: string; ticketKey: string; index: number; total: number }
  | { type: "bugbash:ticket:finished"; sessionId: string; ticketKey: string; index: number; total: number; passed: boolean; runId: string }
  | { type: "bugbash:finished"; sessionId: string; results: BugBashTicketResult[] }
  | { type: "bugbash:cancelled"; sessionId: string };

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
