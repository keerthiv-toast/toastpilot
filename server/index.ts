import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { join, dirname } from "path";
import { readFileSync, existsSync, createReadStream, readdirSync } from "fs";
import { execSync, spawn } from "child_process";
import { writeFileSync, readFileSync as readFS, openSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { createHmac, timingSafeEqual } from "crypto";
import { EventBus } from "./EventBus.js";
import { AgentService } from "./AgentService.js";
import { BugBashQueue } from "./BugBashQueue.js";
import { ChangeDetector } from "../copilot/changeDetection/ChangeDetector.js";
import { JiraClient } from "../jira/JiraClient.js";
import { JiraPlanSynthesizer, buildJiraContext } from "../jira/JiraPlanSynthesizer.js";
import { OpenAIClient } from "../agent/core/OpenAIClient.js";
import { DynamicFlowGenerator } from "../agent/core/DynamicFlowGenerator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.AGENT_SERVER_PORT ?? "9477", 10);
const REPORTS_DIR = join(process.cwd(), "reports");
const ARTIFACTS_DIR = join(process.cwd(), "artifacts");
const app = express();
const httpServer = createServer(app);
const bus = new EventBus();
const agentService = new AgentService(bus);
const changeDetector = new ChangeDetector();
const jiraClient = new JiraClient();
const openaiClient = new OpenAIClient();
const jiraSynthesizer = new JiraPlanSynthesizer(openaiClient);
const dynamicFlowGenerator = new DynamicFlowGenerator();
const bugBashQueue = new BugBashQueue(bus, agentService, jiraClient, jiraSynthesizer);

app.use(cors({ origin: ["http://localhost:5177", "http://127.0.0.1:5177"] }));
// Capture raw body for HMAC verification on the webhook route before JSON parsing consumes it
app.use(express.json({
  verify: (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ToastPilot — Autonomous QA Agent for Unified Inventory",
    scope: "ToastUnifiedInventory",
    openai: Boolean(process.env.OPENAI_API_KEY),
    jira: jiraClient.isConfigured,
    appPath: process.env.TOAST_OPERATOR_APP_PATH ?? "../automation/app/ToastOperator.app",
  });
});

app.get("/api/knowledge/flows", (_req, res) => {
  try {
    const path = join(process.cwd(), "knowledge/inventory-flows.json");
    res.type("json").send(readFileSync(path, "utf-8"));
  } catch {
    res.status(404).json({ error: "Knowledge file not found" });
  }
});

app.get("/api/knowledge/accessibility", (_req, res) => {
  try {
    const path = join(process.cwd(), "knowledge/accessibility-registry.json");
    res.type("json").send(readFileSync(path, "utf-8"));
  } catch {
    res.status(404).json({ error: "Knowledge file not found" });
  }
});

app.get("/api/runs/current", (_req, res) => {
  res.json(agentService.run ?? null);
});

app.get("/api/events", (_req, res) => {
  res.json(bus.getRecentEvents());
});

const JIRA_TICKET_RE = /\b([A-Za-z][A-Za-z0-9_]+-\d+)\b/i;

app.post("/api/commands", async (req, res) => {
  let command = (req.body?.command as string)?.trim();
  if (!command) {
    res.status(400).json({ error: "command is required" });
    return;
  }

  if (agentService.isRunning) {
    res.status(409).json({ error: "A run is already in progress. Cancel it first via POST /api/cancel." });
    return;
  }

  let jiraContext = req.body?.jiraContext ?? undefined;
  const stepActions: string[] | undefined =
    Array.isArray(req.body?.stepActions) && req.body.stepActions.length > 0
      ? req.body.stepActions
      : undefined;

  const jiraMatch = JIRA_TICKET_RE.exec(command);
  if (jiraMatch && !jiraContext && jiraClient.isConfigured) {
    try {
      const ticketKey = jiraMatch[1].toUpperCase();
      const issue = await jiraClient.fetchIssue(ticketKey);
      const synthesis = await jiraSynthesizer.synthesize(issue);
      jiraContext = buildJiraContext(issue, synthesis);
      command = synthesis.command;
      console.log(`[jira] Auto-resolved ${ticketKey} → "${command}" (flow: ${synthesis.flowId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[jira] Auto-resolve failed for "${command}": ${msg} — continuing as plain command`);
    }
  }

  res.status(202).json({ accepted: true, command });

  agentService.start(command, jiraContext, stepActions).catch((err) => {
    console.error("Agent run failed:", err);
  });
});

app.post("/api/jira/analyze", async (req, res) => {
  const ticketKey = (req.body?.ticketKey as string)?.trim();
  if (!ticketKey) {
    res.status(400).json({ error: "ticketKey is required (e.g. SMB-1168)" });
    return;
  }

  if (!jiraClient.isConfigured) {
    res.status(503).json({
      error: "Jira is not configured.",
      hint: "Set JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN in your .env file.",
    });
    return;
  }

  try {
    const issue = await jiraClient.fetchIssue(ticketKey);
    const synthesis = await jiraSynthesizer.synthesize(issue);
    const context = buildJiraContext(issue, synthesis);

    res.json({
      ticketKey: issue.key,
      summary: issue.summary,
      issueType: issue.issueType,
      priority: issue.priority,
      status: issue.status,
      command: synthesis.command,
      flowId: synthesis.flowId,
      rationale: synthesis.rationale,
      acceptanceCriteria: synthesis.acceptanceCriteria,
      jiraContext: context,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jira] Failed to analyze ${ticketKey}:`, message);
    res.status(502).json({ error: message });
  }
});

app.post("/api/jira/create-bug", async (req, res) => {
  if (!jiraClient.isConfigured) {
    res.status(503).json({
      error: "Jira is not configured.",
      hint: "Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECT_KEY in your .env file.",
    });
    return;
  }

  const projectKey = (req.body?.projectKey as string | undefined)?.trim()
    || (process.env.JIRA_PROJECT_KEY ?? "").trim();

  if (!projectKey) {
    res.status(400).json({
      error: "projectKey is required. Set JIRA_PROJECT_KEY in your .env file (e.g. JIRA_PROJECT_KEY=SMB).",
    });
    return;
  }

  const summary = (req.body?.summary as string | undefined)?.trim();
  if (!summary) {
    res.status(400).json({ error: "summary is required." });
    return;
  }

  try {
    const created = await jiraClient.createBug({
      projectKey,
      summary,
      description: (req.body?.description as string | undefined) ?? "",
      stepsToReproduce: (req.body?.stepsToReproduce as string[] | undefined) ?? [],
      failureDetail: (req.body?.failureDetail as string | undefined) ?? "",
      command: (req.body?.command as string | undefined) ?? "",
      runId: (req.body?.runId as string | undefined) ?? "",
      featureName: (req.body?.featureName as string | undefined) ?? "ToastUnifiedInventory",
      priority: (req.body?.priority as "Highest" | "High" | "Medium" | "Low" | "Lowest" | undefined) ?? "High",
      labels: (req.body?.labels as string[] | undefined) ?? [],
    });
    console.log(`[jira] Created bug ${created.key} → ${created.url}`);
    res.json({ key: created.key, url: created.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jira] Failed to create bug:", message);
    res.status(502).json({ error: message });
  }
});

const ARTIFACT_RUN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT_FILE_RE = /^[\w\-.]+\.(mp4|png|jpg|jpeg)$/i;

app.get("/api/artifacts/:runId/screenshot-list", (req, res) => {
  if (!ARTIFACT_RUN_RE.test(req.params.runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }
  const runDir = join(ARTIFACTS_DIR, req.params.runId);
  if (!existsSync(runDir)) {
    res.status(404).send("No artifacts for this run.");
    return;
  }
  const pngs = readdirSync(runDir).filter((f) => f.endsWith(".png")).sort();
  if (pngs.length === 0) {
    res.status(404).send("No screenshots found.");
    return;
  }
  const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const links = pngs.map((f: string) => `<li><img src="/api/artifacts/${req.params.runId}/${escHtml(f)}" style="max-width:320px;border-radius:6px;margin:4px"> <br><small>${escHtml(f)}</small></li>`).join("");
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><body style="background:#1a2332;color:#fff;font-family:sans-serif;padding:1rem"><h2>Screenshots — ${pngs.length} total</h2><ul style="list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px">${links}</ul></body></html>`);
});

app.get("/api/artifacts/:runId/:file", (req, res) => {
  if (!ARTIFACT_RUN_RE.test(req.params.runId) || !ARTIFACT_FILE_RE.test(req.params.file)) {
    res.status(400).json({ error: "Invalid artifact path" });
    return;
  }
  const filePath = join(ARTIFACTS_DIR, req.params.runId, req.params.file);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const ext = req.params.file.split(".").pop()?.toLowerCase();
  const mime = ext === "mp4" ? "video/mp4" : "image/png";
  res.setHeader("Content-Type", mime);
  res.setHeader("Accept-Ranges", "bytes");
  createReadStream(filePath).pipe(res);
});

app.post("/api/jira/attach", async (req, res) => {
  if (!jiraClient.isConfigured) {
    res.status(503).json({ error: "Jira is not configured." });
    return;
  }

  const issueKey = (req.body?.issueKey as string | undefined)?.trim();
  if (!issueKey) {
    res.status(400).json({ error: "issueKey is required." });
    return;
  }

  const runId = (req.body?.runId as string | undefined)?.trim();
  const attachVideo = req.body?.attachVideo === true;
  const attachScreenshots = req.body?.attachScreenshots === true;
  const attachScenarios = req.body?.attachScenarios === true;
  const scenarios = (req.body?.scenarios as Array<{ title: string; description?: string; category?: string }> | undefined) ?? [];

  if (!runId || !ARTIFACT_RUN_RE.test(runId)) {
    res.status(400).json({ error: "Valid runId is required." });
    return;
  }

  const results: { type: string; name: string; ok: boolean; error?: string }[] = [];

  try {
    if (attachScenarios && scenarios.length > 0) {
      try {
        await jiraClient.attachScenariosComment(issueKey, scenarios);
        results.push({ type: "scenarios", name: "Test Scenarios", ok: true });
      } catch (err) {
        results.push({ type: "scenarios", name: "Test Scenarios", ok: false, error: String(err) });
      }
    }

    if (attachScreenshots) {
      const runDir = join(ARTIFACTS_DIR, runId);
      if (existsSync(runDir)) {
        const { readdirSync } = await import("fs");
        const pngs = readdirSync(runDir).filter((f) => f.endsWith(".png")).slice(0, 10);
        for (const png of pngs) {
          const filePath = join(runDir, png);
          try {
            await jiraClient.attachFile(issueKey, filePath, png, "image/png");
            results.push({ type: "screenshot", name: png, ok: true });
          } catch (err) {
            results.push({ type: "screenshot", name: png, ok: false, error: String(err) });
          }
        }
      }
    }

    if (attachVideo) {
      const videoPath = join(ARTIFACTS_DIR, runId, "recording.mp4");
      if (existsSync(videoPath)) {
        try {
          await jiraClient.attachFile(issueKey, videoPath, "recording.mp4", "video/mp4");
          results.push({ type: "video", name: "recording.mp4", ok: true });
        } catch (err) {
          results.push({ type: "video", name: "recording.mp4", ok: false, error: String(err) });
        }
      } else {
        results.push({ type: "video", name: "recording.mp4", ok: false, error: "Recording not found for this run." });
      }
    }

    res.json({ attached: results.filter((r) => r.ok).length, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.post("/api/slack/report", async (req, res) => {
  const webhookUrl = (process.env.SLACK_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) {
    res.status(503).json({ error: "Slack is not configured. Set SLACK_WEBHOOK_URL in your .env file." });
    return;
  }

  const {
    command,
    status,
    featureName,
    risk,
    confidence,
    passed,
    failed,
    recommendation,
    runId,
    environment,
    scenarios,
    jiraTicket,
    jiraBugKey,
    jiraBugUrl,
    screenshotCount,
    hasVideo,
  } = req.body as {
    command?: string; status?: string; featureName?: string; risk?: string;
    confidence?: number; passed?: number; failed?: number;
    recommendation?: string; runId?: string; environment?: string;
    scenarios?: Array<{ title: string; category?: string }>; jiraTicket?: string;
    jiraBugKey?: string; jiraBugUrl?: string; screenshotCount?: number; hasVideo?: boolean;
  };

  const reporter = (process.env.SLACK_REPORTER_NAME ?? process.env.TOAST_TEST_EMAIL ?? "ToastPilot").trim();
  const jiraBase = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const commandDisplay = jiraTicket && jiraBase
    ? `<${jiraBase}/browse/${jiraTicket}|${jiraTicket}>`
    : `\`${command ?? "—"}\``;
  const isPassed = status === "passed" && (failed ?? 0) === 0;
  const statusEmoji = isPassed ? "✅" : "❌";
  const statusLabel = isPassed ? "PASSED" : "FAILED";

  const categoryEmoji: Record<string, string> = {
    happy_path: "✅", negative: "❌", edge: "⚠️", role_based: "👤", permission: "🔐",
  };
  const scenarioLines = (scenarios ?? [])
    .map((s) => `${categoryEmoji[s.category ?? ""] ?? "•"} ${s.title}`)
    .join("\n");

  const confidencePct = confidence == null
    ? null
    : confidence <= 1
      ? Math.round(confidence * 100)
      : Math.round(Math.min(100, confidence));

  const serverBase = `http://localhost:${PORT}`;
  const evidenceParts: string[] = [];
  if (screenshotCount && screenshotCount > 0 && runId) {
    evidenceParts.push(`<${serverBase}/api/artifacts/${runId}/screenshot-list|📸 ${screenshotCount} screenshot${screenshotCount !== 1 ? "s" : ""}>`);
  } else if (screenshotCount && screenshotCount > 0) {
    evidenceParts.push(`📸 ${screenshotCount} screenshot${screenshotCount !== 1 ? "s" : ""}`);
  }
  if (hasVideo && runId) {
    evidenceParts.push(`<${serverBase}/api/artifacts/${runId}/recording.mp4|🎥 Video recording>`);
  } else if (hasVideo) {
    evidenceParts.push("🎥 Video recording");
  }
  if (jiraBugKey && jiraBugUrl) evidenceParts.push(`🐛 Bug filed: <${jiraBugUrl}|${jiraBugKey}>`);

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${statusEmoji} ToastPilot QA Report — ${statusLabel}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Command*\n${commandDisplay}` },
          { type: "mrkdwn", text: `*Feature*\n${featureName ?? "—"}` },
          { type: "mrkdwn", text: `*Status*\n${statusEmoji} ${statusLabel}` },
          { type: "mrkdwn", text: `*Risk*\n${risk ?? "—"}` },
          { type: "mrkdwn", text: `*Steps*\n✅ ${passed ?? 0} passed · ❌ ${failed ?? 0} failed` },
          { type: "mrkdwn", text: `*Confidence*\n${confidencePct != null ? confidencePct + "%" : "—"}` },
        ],
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Environment*\n${environment ?? "Toast Operator · Production Simulator"}` },
          { type: "mrkdwn", text: `*Reported by*\n${reporter}` },
          ...(jiraTicket ? [{ type: "mrkdwn", text: `*Jira Ticket*\n${jiraTicket}` }] : []),
          ...(runId ? [{ type: "mrkdwn", text: `*Run ID*\n\`${runId.slice(0, 8)}…\`` }] : []),
        ],
      },
      ...(recommendation ? [{
        type: "section",
        text: { type: "mrkdwn", text: `*Recommendation*\n${recommendation}` },
      }] : []),
      ...(scenarioLines ? [{
        type: "section",
        text: { type: "mrkdwn", text: `*Test Scenarios*\n${scenarioLines}` },
      }] : []),
      ...(evidenceParts.length > 0 ? [{
        type: "section",
        text: { type: "mrkdwn", text: `*Evidence*\n${evidenceParts.join("  ·  ")}` },
      }] : []),
      { type: "divider" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_Sent by ToastPilot Autonomous QA Agent · ${new Date().toUTCString()}_` }],
      },
    ],
    attachments: [{
      color: isPassed ? "#059669" : "#ef4444",
      fallback: `ToastPilot QA Report: ${statusLabel} — ${command ?? ""}`,
    }],
  };

  try {
    const slackRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!slackRes.ok) {
      const text = await slackRes.text().catch(() => "");
      res.status(502).json({ error: `Slack returned ${slackRes.status}: ${text.slice(0, 200)}` });
      return;
    }
    console.log(`[slack] Report sent for run ${runId ?? "unknown"} — status: ${statusLabel}`);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.get("/api/jira/status", (_req, res) => {
  res.json({
    configured: jiraClient.isConfigured,
    baseUrl: process.env.JIRA_BASE_URL ? process.env.JIRA_BASE_URL.replace(/\/$/, "") : null,
    hint: jiraClient.isConfigured
      ? "Jira is configured. POST /api/jira/analyze { ticketKey } to fetch a ticket."
      : "Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN in .env to enable Jira integration.",
  });
});

app.post("/api/commands/cancel", (_req, res) => {
  agentService.cancel();
  res.json({ cancelled: true });
});

app.post("/api/cancel", (_req, res) => {
  agentService.cancel();
  res.json({ cancelled: true });
});

app.post("/api/copilot/analyze", (req, res) => {
  const result = changeDetector.analyze({
    gitBase: req.body?.gitBase ?? process.env.COPILOT_GIT_BASE,
    prBody: req.body?.prBody ?? process.env.COPILOT_PR_BODY,
    jiraTicket: req.body?.jiraTicket ?? process.env.COPILOT_JIRA_TICKET,
    commitMessage: req.body?.commitMessage,
    command: req.body?.command,
  });
  res.json(result);
});

app.get("/api/copilot/analyze", (_req, res) => {
  res.json(changeDetector.analyze({}));
});

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get("/api/reports/:runId/executive-summary.json", (req, res) => {
  if (!RUN_ID_RE.test(req.params.runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }
  const jsonPath = join(REPORTS_DIR, `${req.params.runId}-executive-summary.json`);
  if (!existsSync(jsonPath)) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  res.type("json").send(readFileSync(jsonPath, "utf-8"));
});

app.get("/api/reports/:runId/executive-summary.html", (req, res) => {
  if (!RUN_ID_RE.test(req.params.runId)) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }
  const htmlPath = join(REPORTS_DIR, `${req.params.runId}-executive-summary.html`);
  if (!existsSync(htmlPath)) {
    res.status(404).send("Report not found");
    return;
  }
  res.type("html").send(readFileSync(htmlPath, "utf-8"));
});

const IOS_REPO = process.env.IOS_REPO_PATH ??
  join(__dirname, "../../../..");

app.get("/api/git/status", (_req, res) => {
  try {
    const git = (cmd: string) =>
      execSync(cmd, { cwd: IOS_REPO, encoding: "utf-8" }).trim();

    spawn("git", ["-C", IOS_REPO, "fetch", "origin", "main", "--quiet"], {
      stdio: "ignore",
      detached: true,
    }).unref();

    const currentMainSha = git("git rev-parse --short origin/main");
    const latestCommitMsg = git("git log -1 --format=%s origin/main").slice(0, 80);

    const buildState = readBuildState();
    const builtFromSha = buildState.builtFromMainSha;

    let newOnMainCount = 0;
    let upToDate = false;

    if (builtFromSha) {
      try {
        newOnMainCount = Number(git(`git rev-list --count ${builtFromSha}..origin/main`));
        upToDate = newOnMainCount === 0;
      } catch {
        newOnMainCount = -1;
      }
    }

    res.json({
      currentMainSha,
      latestCommitMsg,
      builtFromSha: builtFromSha ?? null,
      newOnMainCount,
      upToDate,
      buildInProgress: buildState.inProgress,
      lastBuiltAt: buildState.finishedAt ?? buildState.startedAt ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `git status failed: ${message}` });
  }
});

const BUILD_STATE_FILE = join(__dirname, "../.build-state.json");

interface BuildState {
  inProgress: boolean;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  lastLines: string;
  builtFromMainSha?: string;
}

function readBuildState(): BuildState {
  try {
    return JSON.parse(readFS(BUILD_STATE_FILE, "utf-8")) as BuildState;
  } catch {
    return { inProgress: false, lastLines: "" };
  }
}

function writeBuildState(state: BuildState): void {
  try { writeFileSync(BUILD_STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

(function reconcileBuildState() {
  const state = readBuildState();

  if (state.inProgress && state.pid) {
    try {
      process.kill(state.pid, 0);
      console.log(`[build] Resuming tracking of detached build pid=${state.pid}`);
    } catch {
      console.log(`[build] Previous build pid=${state.pid} is no longer running — marking finished`);
      writeBuildState({ ...state, inProgress: false, finishedAt: new Date().toISOString() });
    }
    return;
  }

  if (!state.builtFromMainSha) {
    const sidecarPath = join(__dirname, "../../automation/app/.build-sha");
    const appBundle = join(__dirname, "../../automation/app/ToastOperator.app");
    try {
      if (existsSync(sidecarPath)) {
        const { sha, builtAt } = JSON.parse(readFS(sidecarPath, "utf-8")) as { sha: string; builtAt: string };
        if (sha) {
          console.log(`[build] Read builtFromMainSha=${sha} from sidecar (.build-sha)`);
          writeBuildState({ ...state, builtFromMainSha: sha, finishedAt: builtAt });
          return;
        }
      }
      try {
        const plist = join(appBundle, "Info.plist");
        if (existsSync(plist)) {
          const appVersion = execSync(
            `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plist}"`,
            { encoding: "utf-8" }
          ).trim();
          if (appVersion) {
            const sha = execSync(
              `git -C "${IOS_REPO}" log origin/main --grep="Bumping version to ${appVersion}" --format="%h" -1`,
              { encoding: "utf-8" }
            ).trim();
            if (sha) {
              console.log(`[build] Matched builtFromMainSha=${sha} from app version ${appVersion}`);
              writeBuildState({ ...state, builtFromMainSha: sha, finishedAt: statSync(appBundle).mtime.toISOString() });
              return;
            }
          }
        }
      } catch { /* version detection failed */ }
    } catch { /* app bundle may not exist yet */ }
  }
})();

const npxBin = (() => { try { return execSync("which npx", { encoding: "utf-8" }).trim(); } catch { return "npx"; } })();

app.post("/api/build", (_req, res) => {
  if (agentService.isRunning) {
    res.status(409).json({ error: "A test run is in progress. Stop it before rebuilding." });
    return;
  }
  const current = readBuildState();
  if (current.inProgress) {
    res.status(409).json({ error: "A build is already in progress." });
    return;
  }

  const script = join(__dirname, "../scripts/build-operator-app.ts");
  const cwd = join(__dirname, "..");
  const buildLogFile = join(__dirname, "../.build-output.log");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_FORCE_REBUILD: "true" };

  let builtFromMainSha: string | undefined;
  try {
    execSync(`git -C "${IOS_REPO}" fetch origin main --quiet`);
    builtFromMainSha = execSync(`git -C "${IOS_REPO}" rev-parse --short origin/main`, { encoding: "utf-8" }).trim();
  } catch { /* best-effort */ }

  try { writeFileSync(buildLogFile, ""); } catch { /* ok */ }
  const logFd = openSync(buildLogFile, "a");

  const proc = spawn(npxBin, ["tsx", script], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  const pid = proc.pid;
  if (!pid) {
    writeBuildState({ inProgress: false, lastLines: "Spawn failed — no pid assigned" });
    res.status(500).json({ error: "Failed to spawn build process" });
    return;
  }
  writeBuildState({ inProgress: true, pid, startedAt: new Date().toISOString(), lastLines: "", builtFromMainSha });
  res.status(202).json({ accepted: true, message: "Build started", pid });
  console.log(`[build] Spawned detached build pid=${pid}, logging to ${buildLogFile}`);

  proc.on("close", (code) => {
    const tail = (() => { try { return readFS(buildLogFile, "utf-8").split("\n").filter(Boolean).slice(-8).join("\n"); } catch { return ""; } })();
    writeBuildState({ inProgress: false, pid, finishedAt: new Date().toISOString(), exitCode: code, lastLines: tail, builtFromMainSha });
    if (code === 0 && builtFromMainSha) {
      try {
        const sidecarPath = join(__dirname, "../../automation/app/.build-sha");
        writeFileSync(sidecarPath, JSON.stringify({ sha: builtFromMainSha, builtAt: new Date().toISOString() }));
      } catch { /* best-effort */ }
    }
    console.log(`[build] pid=${pid} finished with exit code ${code}`);
  });
  proc.on("error", (err) => {
    writeBuildState({ inProgress: false, pid, finishedAt: new Date().toISOString(), exitCode: -1, lastLines: String(err), builtFromMainSha });
    console.error("[build] Spawn error:", err);
  });

  proc.unref();
});

app.get("/api/build/status", (_req, res) => {
  const state = readBuildState();
  if (state.inProgress) {
    try {
      const buildLogFile = join(__dirname, "../.build-output.log");
      const tail = readFS(buildLogFile, "utf-8").split("\n").filter(Boolean).slice(-6).join("\n");
      res.json({ inProgress: true, lastLines: tail });
      return;
    } catch { /* fall through */ }
  }
  res.json({ inProgress: state.inProgress, lastLines: state.lastLines, exitCode: state.exitCode });
});

// ---------------------------------------------------------------------------
// Bug Bash — bulk sequential ticket testing
// ---------------------------------------------------------------------------

/**
 * POST /api/bug-bash/start
 * Body: { tickets: string[] }   — array of Jira ticket keys, e.g. ["SMB-123", "SMB-456"]
 * Responds immediately 202; the queue runs fire-and-forget, emitting bugbash:* WebSocket events.
 */
app.post("/api/bug-bash/start", async (req, res) => {
  if (bugBashQueue.isRunning) {
    res.status(409).json({ error: "A bug bash session is already running. Cancel it first via POST /api/bug-bash/cancel." });
    return;
  }

  const rawTickets = req.body?.tickets;
  if (!Array.isArray(rawTickets) || rawTickets.length === 0) {
    res.status(400).json({ error: "tickets must be a non-empty array of Jira ticket keys." });
    return;
  }

  const SMB_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
  const tickets: string[] = rawTickets
    .map((t: unknown) => String(t).trim().toUpperCase())
    .filter((t) => SMB_RE.test(t));

  if (tickets.length === 0) {
    res.status(400).json({ error: "No valid Jira ticket keys found. Keys must match pattern ABC-123." });
    return;
  }

  if (!jiraClient.isConfigured) {
    res.status(503).json({
      error: "Jira is not configured. Set JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN in .env.",
    });
    return;
  }

  res.status(202).json({ accepted: true, tickets, count: tickets.length });

  bugBashQueue.start(tickets).catch((err) => {
    console.error("[bug-bash] Unhandled error in start():", err);
  });
});

/** POST /api/bug-bash/cancel — abort the running session after the current ticket finishes */
app.post("/api/bug-bash/cancel", (_req, res) => {
  bugBashQueue.cancel();
  res.json({ cancelled: true });
});

/** GET /api/bug-bash/status — lightweight polling fallback */
app.get("/api/bug-bash/status", (_req, res) => {
  res.json({ running: bugBashQueue.isRunning, sessionId: bugBashQueue.sessionId });
});

// ---------------------------------------------------------------------------
// POST /api/webhook/pr-merged
// Called by GitHub Actions when a PR is merged to main in this repo.
// Only SMB-* Jira tickets are processed — other projects are ignored.
// Validates the GitHub HMAC-SHA256 signature when GITHUB_WEBHOOK_SECRET is set.
// ---------------------------------------------------------------------------

/** Extract the first SMB-NNNN ticket from a string (PR title, branch name, body). */
function extractSmbTicket(text: string): string | null {
  const m = /\bSMB-\d+\b/i.exec(text ?? "");
  return m ? m[0].toUpperCase() : null;
}

/** Verify GitHub's X-Hub-Signature-256 header. Returns true when no secret is configured (dev mode). */
function verifyGitHubSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return true; // no secret configured → allow (dev / internal use)
  if (!signature?.startsWith("sha256=")) return false;
  const sigHex = signature.slice(7);
  if (sigHex.length !== 64) return false; // SHA-256 hex is always 64 chars
  // Compare raw digest bytes (not hex strings) to avoid encoding ambiguity
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const sigBuf = Buffer.from(sigHex, "hex");
  return timingSafeEqual(sigBuf, expected);
}

/** Post a plain Slack message — used for manual-testing-needed notifications. */
async function postSlackMessage(text: string): Promise<void> {
  const webhookUrl = (process.env.SLACK_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch((e) => console.warn("[slack] postSlackMessage failed:", e));
}

/**
 * Full autonomous post-merge QA loop:
 *  1. Fetch & synthesize the Jira ticket
 *  2. If not mappable to a flow → Slack "needs manual testing" and exit
 *  3. Run the agent flow
 *  4. On completion: attach evidence to Jira + send Slack report
 */
async function runPostMergeQA(ticketKey: string, prTitle: string, prUrl: string, prNumber?: number): Promise<void> {
  console.log(`[pr-webhook] Starting autonomous QA for ${ticketKey} (PR: "${prTitle}")`);

  const jiraBase = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const ticketUrl = jiraBase ? `${jiraBase}/browse/${ticketKey}` : ticketKey;
  const reporter = (process.env.SLACK_REPORTER_NAME ?? process.env.TOAST_TEST_EMAIL ?? "ToastPilot").trim();

  // Step 1 — synthesize Jira ticket into a flow
  let jiraContext;
  let command: string;
  let flowId: string;

  try {
    const issue = await jiraClient.fetchIssue(ticketKey);
    const synthesis = await jiraSynthesizer.synthesize(issue);
    jiraContext = buildJiraContext(issue, synthesis);
    command = synthesis.command;
    flowId = synthesis.flowId;
    console.log(`[pr-webhook] ${ticketKey} → flow "${flowId}", command: "${command}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pr-webhook] Jira fetch/synthesis failed for ${ticketKey}: ${msg}`);
    await postSlackMessage(
      `⚠️ *ToastPilot — Manual Testing Required*\n` +
      `PR merged: <${prUrl}|${prTitle}>\n` +
      `Jira ticket: <${ticketUrl}|${ticketKey}> could not be fetched/synthesised.\n` +
      `*Action needed:* Please test this ticket manually.\n` +
      `_Reported by ${reporter}_`,
    );
    return;
  }

  // Step 2 — check if the flow is testable by the agent.
  // "minimal-smoke" means the synthesizer couldn't map to a specific flow →
  // try the Dynamic Flow Generator before falling back to manual notification.
  const NON_TESTABLE_FLOWS = new Set(["not-testable", "manual-only", "infrastructure", "backend-only"]);
  const isHardUntestable =
    NON_TESTABLE_FLOWS.has(flowId) ||
    jiraContext.components?.some((c: string) => /backend|infra|ios.build/i.test(c));

  const isWeakMatch = flowId === "minimal-smoke" && !isHardUntestable;

  let dynamicPlan = null;
  if (isWeakMatch || isHardUntestable) {
    if (!isHardUntestable) {
      // Weak match — try to dynamically generate a targeted flow from the PR diff
      console.log(`[pr-webhook] ${ticketKey} matched only minimal-smoke — attempting dynamic flow generation`);
      try {
        dynamicPlan = await dynamicFlowGenerator.generate({ prNumber, prTitle, jiraContext });
        if (dynamicPlan) {
          console.log(`[pr-webhook] Dynamic flow generated: "${dynamicPlan.flowName}" (${dynamicPlan.steps.length} steps)`);
          // Notify Slack that a dynamic plan was created
          await postSlackMessage(
            `🤖 *ToastPilot — Dynamic Test Flow Generated*\n` +
            `PR merged: <${prUrl}|${prTitle}>\n` +
            `Jira ticket: <${ticketUrl}|${ticketKey}> — ${jiraContext.summary}\n` +
            `Flow: *${dynamicPlan.flowName}* (${dynamicPlan.steps.length} steps)\n` +
            `_AI generated this flow from the PR diff and acceptance criteria — running now…_\n` +
            `_Reported by ${reporter}_`,
          );
        }
      } catch (err) {
        console.warn(`[pr-webhook] Dynamic flow generation failed:`, err);
      }
    }

    if (!dynamicPlan) {
      // No dynamic plan could be generated — send manual testing notification
      const reason = isHardUntestable
        ? "This change is backend/infrastructure — no UI flow to run."
        : "No existing or generated flow could cover this ticket's changes.";
      console.log(`[pr-webhook] ${ticketKey} is not agent-testable — sending Slack notification. Reason: ${reason}`);
      await postSlackMessage(
        `⚠️ *ToastPilot — Manual Testing Required*\n` +
        `PR merged: <${prUrl}|${prTitle}>\n` +
        `Jira ticket: <${ticketUrl}|${ticketKey}> — ${jiraContext.summary}\n` +
        `*Reason:* ${reason}\n` +
        `_Reported by ${reporter}_`,
      );
      return;
    }
  }

  // Step 3 — run the agent (dynamic plan takes precedence over synthesised command)
  let run;
  try {
    const runCommand = dynamicPlan ? dynamicPlan.flowId : command;
    run = await agentService.start(runCommand, jiraContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pr-webhook] Agent run failed for ${ticketKey}:`, msg);
    await postSlackMessage(
      `❌ *ToastPilot — QA Run Failed to Start*\n` +
      `Jira ticket: <${ticketUrl}|${ticketKey}>\n` +
      `Error: ${msg}\n` +
      `_Reported by ${reporter}_`,
    );
    return;
  }

  const runId = run.id;
  const passed = run.status === "passed";
  const stepsPassed = run.plan?.steps.filter((s) => s.status === "passed").length ?? 0;
  const stepsFailed = run.plan?.steps.filter((s) => s.status === "failed").length ?? 0;
  const screenshotCount = run.screenshots?.length ?? 0;
  const hasVideo = Boolean(run.videoPath);

  console.log(`[pr-webhook] Run ${runId} finished — status: ${run.status}, passed: ${stepsPassed}, failed: ${stepsFailed}`);

  // Step 4a — attach evidence to Jira
  if (jiraClient.isConfigured) {
    try {
      const scenarios = (jiraContext.acceptanceCriteria ?? []).map((ac: string) => ({
        title: ac,
        category: "happy_path",
      }));

      // Attach scenarios comment
      if (scenarios.length > 0) {
        await jiraClient.attachScenariosComment(ticketKey, scenarios).catch((e) =>
          console.warn(`[pr-webhook] Jira scenarios comment failed:`, e),
        );
      }

      // Attach screenshots
      const runDir = join(ARTIFACTS_DIR, runId);
      if (existsSync(runDir)) {
        const pngs = readdirSync(runDir).filter((f) => f.endsWith(".png")).slice(0, 10);
        for (const png of pngs) {
          await jiraClient.attachFile(ticketKey, join(runDir, png), png, "image/png").catch((e) =>
            console.warn(`[pr-webhook] Jira screenshot attach failed (${png}):`, e),
          );
        }
      }

      // Attach video
      const videoPath = join(ARTIFACTS_DIR, runId, "recording.mp4");
      if (existsSync(videoPath)) {
        await jiraClient.attachFile(ticketKey, videoPath, "recording.mp4", "video/mp4").catch((e) =>
          console.warn(`[pr-webhook] Jira video attach failed:`, e),
        );
      }

      console.log(`[pr-webhook] Evidence attached to Jira ${ticketKey}`);
    } catch (err) {
      console.warn(`[pr-webhook] Jira evidence attachment failed:`, err);
    }
  }

  // Step 4b — send Slack report
  const webhookUrl = (process.env.SLACK_WEBHOOK_URL ?? "").trim();
  if (webhookUrl) {
    const statusEmoji = passed ? "✅" : "❌";
    const statusLabel = passed ? "PASSED" : "FAILED";
    const serverBase = `http://localhost:${PORT}`;
    const evidenceParts: string[] = [];
    if (screenshotCount > 0) evidenceParts.push(`<${serverBase}/api/artifacts/${runId}/screenshot-list|📸 ${screenshotCount} screenshot${screenshotCount !== 1 ? "s" : ""}>`);
    if (hasVideo) evidenceParts.push(`<${serverBase}/api/artifacts/${runId}/recording.mp4|🎥 Video recording>`);

    const payload = {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `${statusEmoji} ToastPilot — PR Auto-QA ${statusLabel}`, emoji: true },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Jira Ticket*\n<${ticketUrl}|${ticketKey}> — ${jiraContext.summary}` },
            { type: "mrkdwn", text: `*PR*\n<${prUrl}|${prTitle}>` },
            { type: "mrkdwn", text: `*Status*\n${statusEmoji} ${statusLabel}` },
            { type: "mrkdwn", text: `*Steps*\n✅ ${stepsPassed} passed · ❌ ${stepsFailed} failed` },
            { type: "mrkdwn", text: `*Flow*\n\`${dynamicPlan ? dynamicPlan.flowName : flowId}\`${dynamicPlan ? " _(AI-generated)_" : ""}` },
            { type: "mrkdwn", text: `*Reported by*\n${reporter}` },
          ],
        },
        ...(evidenceParts.length > 0 ? [{
          type: "section",
          text: { type: "mrkdwn", text: `*Evidence*\n${evidenceParts.join("  ·  ")}` },
        }] : []),
        ...(run.failureExplanation ? [{
          type: "section",
          text: { type: "mrkdwn", text: `*Failure*\n${run.failureExplanation.slice(0, 300)}` },
        }] : []),
        { type: "divider" },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `_Triggered automatically by PR merge · ToastPilot Autonomous QA · ${new Date().toUTCString()}_` }],
        },
      ],
      attachments: [{
        color: passed ? "#059669" : "#ef4444",
        fallback: `ToastPilot Auto-QA: ${statusLabel} — ${ticketKey} (${prTitle})`,
      }],
    };

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      if (!r.ok) console.warn(`[pr-webhook] Slack returned ${r.status}: ${await r.text().catch(() => "")}`);
      else console.log(`[pr-webhook] Slack notification sent for ${ticketKey} — ${statusLabel}`);
    }).catch((e) => console.warn("[pr-webhook] Slack post failed:", e));
  }
}

app.post("/api/webhook/pr-merged", async (req, res) => {
  // Verify GitHub signature using raw body captured by the express.json verify callback
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !verifyGitHubSignature(rawBody, sig)) {
    console.warn("[pr-webhook] Rejected request — invalid signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Body already parsed by express.json middleware
  const payload = req.body as Record<string, unknown>;
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  // Only process merged PRs
  const action = payload.action as string | undefined;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const merged = pr?.merged as boolean | undefined;
  if (action !== "closed" || !merged) {
    res.json({ skipped: true, reason: "not a merged PR" });
    return;
  }

  const prTitle = (pr?.title as string | undefined) ?? "";
  const prUrl = (pr?.html_url as string | undefined) ?? "";
  const prNumber = typeof pr?.number === "number" ? pr.number : undefined;
  const branchName = ((pr?.head as Record<string, unknown> | undefined)?.ref as string | undefined) ?? "";
  const prBody = (pr?.body as string | undefined) ?? "";
  const baseBranch = ((pr?.base as Record<string, unknown> | undefined)?.ref as string | undefined) ?? "";

  // Only process merges into main
  if (baseBranch !== "main") {
    res.json({ skipped: true, reason: `base branch is "${baseBranch}", not "main"` });
    return;
  }

  // Extract SMB-NNNN ticket — search title, branch name, then body
  const ticketKey = extractSmbTicket(prTitle) ?? extractSmbTicket(branchName) ?? extractSmbTicket(prBody);
  if (!ticketKey) {
    console.log(`[pr-webhook] No SMB-* ticket found in PR "${prTitle}" (branch: ${branchName}) — skipping`);
    res.json({ skipped: true, reason: "no SMB-* ticket found in PR title, branch, or body" });
    return;
  }

  // Check if agent+Jira are configured enough to run
  if (!jiraClient.isConfigured) {
    console.warn(`[pr-webhook] Jira not configured — sending manual-testing Slack for ${ticketKey}`);
    await postSlackMessage(
      `⚠️ *ToastPilot — Manual Testing Required*\n` +
      `PR merged: <${prUrl}|${prTitle}>\n` +
      `Jira ticket: *${ticketKey}* — Jira integration is not configured on this agent.\n` +
      `*Action needed:* Please test this ticket manually.\n` +
      `_Reported by ToastPilot_`,
    );
    res.json({ accepted: true, ticketKey, note: "Jira not configured — manual testing Slack sent" });
    return;
  }

  // Respond immediately — the QA run is async and can take several minutes
  res.json({ accepted: true, ticketKey, prTitle });
  console.log(`[pr-webhook] Accepted PR merge event — running autonomous QA for ${ticketKey}`);

  // Fire-and-forget — errors are caught inside runPostMergeQA
  runPostMergeQA(ticketKey, prTitle, prUrl, prNumber).catch((err) => {
    console.error(`[pr-webhook] Unhandled error in runPostMergeQA(${ticketKey}):`, err);
  });
});

const dashboardDist = join(process.cwd(), "dashboard/dist");
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(join(dashboardDist, "index.html"));
  });
}

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws, req) => {
  const origin = req.headers.origin ?? "";
  if (origin && !["http://localhost:5177", "http://127.0.0.1:5177"].includes(origin)) {
    ws.close(1008, "Forbidden");
    return;
  }
  bus.subscribe(ws);
});

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ToastPilot — Autonomous QA Agent for Unified Inventory      ║
║  REST API:  http://localhost:${PORT}/api                       ║
║  Copilot:   http://localhost:${PORT}/api/copilot/analyze       ║
║  WebSocket: ws://localhost:${PORT}/ws                            ║
║  Dashboard: npm run demo (port ${process.env.AGENT_DASHBOARD_PORT ?? 5177})          ║
╚══════════════════════════════════════════════════════════════╝
`);
});
