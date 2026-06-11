import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { AgentEvent, BugBashTicketResult } from "../agent/types.js";
import type { EventBus } from "./EventBus.js";
import type { AgentService } from "./AgentService.js";
import type { JiraClient } from "../jira/JiraClient.js";
import type { JiraPlanSynthesizer } from "../jira/JiraPlanSynthesizer.js";
import { buildJiraContext } from "../jira/JiraPlanSynthesizer.js";

const ARTIFACTS_DIR = join(process.cwd(), "artifacts");

export class BugBashQueue {
  private running = false;
  private aborted = false;
  private currentSessionId: string | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly agentService: AgentService,
    private readonly jiraClient: JiraClient,
    private readonly jiraSynthesizer: JiraPlanSynthesizer,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  cancel(): void {
    this.aborted = true;
    this.agentService.cancel();
  }

  /**
   * Run all tickets sequentially. Each ticket goes through:
   *   1. Jira lookup + synthesis
   *   2. Agent run (same pipeline as single-ticket PR-merge)
   *   3. Jira evidence attachment
   * When all tickets finish an aggregate Slack block-kit summary is posted.
   */
  async start(tickets: string[]): Promise<void> {
    if (this.running) throw new Error("A bug bash session is already running.");
    if (tickets.length === 0) throw new Error("No tickets provided.");

    this.running = true;
    this.aborted = false;
    const sessionId = randomUUID();
    this.currentSessionId = sessionId;

    const emit = (event: AgentEvent) => this.bus.publish(event);

    emit({ type: "bugbash:started", sessionId, tickets: [...tickets] });

    const results: BugBashTicketResult[] = [];

    try {
      for (let i = 0; i < tickets.length; i++) {
        if (this.aborted) break;

        const ticketKey = tickets[i].trim().toUpperCase();
        emit({ type: "bugbash:ticket:started", sessionId, ticketKey, index: i, total: tickets.length });
        console.log(`[bug-bash] [${i + 1}/${tickets.length}] Starting ${ticketKey}`);

        let result: BugBashTicketResult;
        try {
          result = await this.runTicket(ticketKey, sessionId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[bug-bash] ${ticketKey} threw unexpectedly:`, msg);
          result = {
            ticketKey,
            passed: false,
            runId: "",
            stepsPassed: 0,
            stepsFailed: 0,
            screenshotCount: 0,
            hasVideo: false,
            failureExplanation: msg,
          };
        }

        results.push(result);
        emit({
          type: "bugbash:ticket:finished",
          sessionId,
          ticketKey,
          index: i,
          total: tickets.length,
          passed: result.passed,
          runId: result.runId,
        });

        console.log(`[bug-bash] [${i + 1}/${tickets.length}] ${ticketKey} → ${result.passed ? "PASSED" : "FAILED"}`);
      }

      if (this.aborted) {
        emit({ type: "bugbash:cancelled", sessionId });
        console.log("[bug-bash] Session cancelled.");
      } else {
        emit({ type: "bugbash:finished", sessionId, results });
        console.log(`[bug-bash] Session complete — ${results.filter((r) => r.passed).length}/${results.length} passed`);
        await this.postAggregateSlack(results);
      }
    } finally {
      this.running = false;
      this.currentSessionId = null;
    }
  }

  private async runTicket(ticketKey: string, _sessionId: string): Promise<BugBashTicketResult> {
    // 1. Jira lookup + synthesis
    let jiraContext;
    let command: string;
    let summary: string | undefined;

    try {
      const issue = await this.jiraClient.fetchIssue(ticketKey);
      const synthesis = await this.jiraSynthesizer.synthesize(issue);
      jiraContext = buildJiraContext(issue, synthesis);
      command = synthesis.command;
      summary = issue.summary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bug-bash] Jira fetch failed for ${ticketKey}: ${msg}`);
      return {
        ticketKey,
        passed: false,
        runId: "",
        summary: undefined,
        stepsPassed: 0,
        stepsFailed: 0,
        screenshotCount: 0,
        hasVideo: false,
        failureExplanation: `Jira fetch failed: ${msg}`,
      };
    }

    if (this.aborted) {
      return { ticketKey, passed: false, runId: "", summary, stepsPassed: 0, stepsFailed: 0, screenshotCount: 0, hasVideo: false, failureExplanation: "Cancelled" };
    }

    // 2. Run the agent
    let run;
    try {
      run = await this.agentService.start(command, jiraContext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ticketKey,
        passed: false,
        runId: "",
        summary,
        stepsPassed: 0,
        stepsFailed: 0,
        screenshotCount: 0,
        hasVideo: false,
        failureExplanation: `Run failed to start: ${msg}`,
      };
    }

    const runId = run.id;
    const passed = run.status === "passed";
    const stepsPassed = run.plan?.steps.filter((s) => s.status === "passed").length ?? 0;
    const stepsFailed = run.plan?.steps.filter((s) => s.status === "failed").length ?? 0;
    const screenshotCount = run.screenshots?.length ?? 0;
    const hasVideo = Boolean(run.videoPath);

    // 3. Attach evidence to Jira (best-effort)
    if (this.jiraClient.isConfigured && runId) {
      try {
        const runDir = join(ARTIFACTS_DIR, runId);
        if (existsSync(runDir)) {
          const pngs = readdirSync(runDir).filter((f) => f.endsWith(".png")).slice(0, 10);
          for (const png of pngs) {
            await this.jiraClient.attachFile(ticketKey, join(runDir, png), png, "image/png").catch((e) =>
              console.warn(`[bug-bash] Jira screenshot attach failed (${png}):`, e),
            );
          }
        }
        const videoPath = join(ARTIFACTS_DIR, runId, "recording.mp4");
        if (existsSync(videoPath)) {
          await this.jiraClient.attachFile(ticketKey, videoPath, "recording.mp4", "video/mp4").catch((e) =>
            console.warn(`[bug-bash] Jira video attach failed:`, e),
          );
        }
        // Post QA result as a Jira comment using attachScenariosComment-compatible structure
        const statusText = passed ? "PASSED ✅" : "FAILED ❌";
        const scenarios = [
          { title: `Bug Bash Result: ${statusText}`, category: passed ? "happy_path" : "negative", description: `Steps: ${stepsPassed} passed · ${stepsFailed} failed · Run ID: ${runId}${run.failureExplanation ? `\nFailure: ${run.failureExplanation.slice(0, 200)}` : ""}` },
        ];
        await this.jiraClient.attachScenariosComment(ticketKey, scenarios).catch((e) =>
          console.warn(`[bug-bash] Jira comment failed:`, e),
        );
      } catch (err) {
        console.warn(`[bug-bash] Jira evidence attachment failed for ${ticketKey}:`, err);
      }
    }

    return {
      ticketKey,
      passed,
      runId,
      summary,
      stepsPassed,
      stepsFailed,
      screenshotCount,
      hasVideo,
      failureExplanation: run.failureExplanation,
    };
  }

  private async postAggregateSlack(results: BugBashTicketResult[]): Promise<void> {
    const webhookUrl = (process.env.SLACK_WEBHOOK_URL ?? "").trim();
    if (!webhookUrl) return;

    const jiraBase = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
    const reporter = (process.env.SLACK_REPORTER_NAME ?? process.env.TOAST_TEST_EMAIL ?? "ToastPilot").trim();
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const allPassed = failed === 0;
    const statusEmoji = allPassed ? "✅" : "❌";
    const statusLabel = allPassed ? "ALL PASSED" : `${failed} FAILED`;

    const ticketLines = results.map((r) => {
      const icon = r.passed ? "✅" : "❌";
      const link = jiraBase ? `<${jiraBase}/browse/${r.ticketKey}|${r.ticketKey}>` : r.ticketKey;
      const summary = r.summary ? ` — ${r.summary.slice(0, 60)}` : "";
      const steps = `(${r.stepsPassed}✅ ${r.stepsFailed}❌)`;
      const fail = r.failureExplanation ? `\n    _${r.failureExplanation.slice(0, 120)}_` : "";
      return `${icon} ${link}${summary} ${steps}${fail}`;
    }).join("\n");

    const payload = {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `${statusEmoji} ToastPilot Bug Bash — ${statusLabel}`, emoji: true },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Tickets Tested*\n${results.length}` },
            { type: "mrkdwn", text: `*Passed*\n✅ ${passed}` },
            { type: "mrkdwn", text: `*Failed*\n❌ ${failed}` },
            { type: "mrkdwn", text: `*Reported by*\n${reporter}` },
          ],
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Ticket Results*\n${ticketLines}` },
        },
        { type: "divider" },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `_ToastPilot Bug Bash · Autonomous QA · ${new Date().toUTCString()}_` }],
        },
      ],
      attachments: [{
        color: allPassed ? "#059669" : "#ef4444",
        fallback: `ToastPilot Bug Bash: ${passed}/${results.length} passed`,
      }],
    };

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      if (!r.ok) console.warn(`[bug-bash] Slack returned ${r.status}: ${await r.text().catch(() => "")}`);
      else console.log(`[bug-bash] Aggregate Slack summary sent — ${passed}/${results.length} passed`);
    }).catch((e) => console.warn("[bug-bash] Slack post failed:", e));
  }
}
