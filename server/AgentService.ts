import type { AgentRun, JiraContext, RunStatus } from "../agent/types.js";
import { AgentOrchestrator } from "../agent/core/AgentOrchestrator.js";
import { EventBus } from "./EventBus.js";

const ACTIVE_STATUSES: RunStatus[] = ["planning", "booting", "running", "healing"];

export class AgentService {
  private orchestrator: AgentOrchestrator | null = null;
  private activeRun: AgentRun | null = null;
  private runGeneration = 0;

  constructor(private readonly bus: EventBus) {}

  get run(): AgentRun | null {
    return this.activeRun;
  }

  get isRunning(): boolean {
    return this.activeRun !== null && ACTIVE_STATUSES.includes(this.activeRun.status);
  }

  /**
   * Start a new run. If another run is active, cancel it first so rapid back-to-back
   * commands from the dashboard always run the latest command.
   */
  async start(command: string, jiraContext?: JiraContext, stepActions?: string[]): Promise<AgentRun> {
    const generation = ++this.runGeneration;

    if (
      this.orchestrator &&
      this.activeRun &&
      ACTIVE_STATUSES.includes(this.activeRun.status)
    ) {
      await this.orchestrator.cancelNow();
      this.activeRun = { ...this.activeRun, status: "cancelled" };
    }

    if (generation !== this.runGeneration) {
      throw new Error("Run superseded by a newer command");
    }

    this.orchestrator = new AgentOrchestrator((event) => this.bus.publish(event));
    const runPromise = this.orchestrator.runCommand(command, jiraContext, stepActions);
    this.activeRun = this.orchestrator.currentRun;

    try {
      const run = await runPromise;
      if (generation === this.runGeneration) {
        this.activeRun = run;
      }
      return run;
    } catch (error) {
      if (generation === this.runGeneration) {
        this.activeRun = this.orchestrator.currentRun ?? this.activeRun;
      }
      throw error;
    }
  }

  cancel(): void {
    this.runGeneration++;
    void this.orchestrator?.cancelNow();
  }
}
