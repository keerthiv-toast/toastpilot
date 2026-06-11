import { OpenAIClient } from "./OpenAIClient.js";
import type { AgentRun, TestStep } from "../types.js";

export class FailureExplainer {
  private readonly openai = new OpenAIClient();

  async explain(run: AgentRun, failedStep: TestStep, error: string, pageSource?: string): Promise<string> {
    return this.openai.explainFailure({
      command: run.command,
      step: `${failedStep.id}: ${failedStep.description}`,
      error,
      pageSourceSnippet: pageSource?.slice(0, 4000),
      healingAttempted: run.healingEvents.length > 0,
    });
  }
}
