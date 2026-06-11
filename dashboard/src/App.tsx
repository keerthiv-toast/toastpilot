import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFlowCompletionCopy } from "@agent/core/flowCompletion";
import { useAgentWebSocket } from "./hooks/useAgentWebSocket";
import { useGitStatus } from "./hooks/useGitStatus";
import { toConfidencePercent } from "./confidence";
import type { BugBashState } from "./types";

const DEMO_COMMAND = "Test Cycle Count inventory flow";
const JIRA_BASE_URL = "https://jira.toasttab.com/browse";

type FlowItem = { label: string; command: string };
type FlowModule = { module: string; flows: FlowItem[] };

const MODULE_ICONS: Record<string, string> = {
  "Smoke & Regression": "🧪",
  "Cycle Counting": "🔢",
  "Product Catalog": "📦",
  "Invoice Scanning": "📄",
  "Auth": "🔐",
};

const FLOW_MENU: FlowModule[] = [
  {
    module: "Smoke & Regression",
    flows: [
      { label: "Full App Smoke (all modules, login → logout)", command: "full-smoke" },
      { label: "Full App Regression (all modules, every flow)", command: "full-regression" },
    ],
  },
  {
    module: "Cycle Counting",
    flows: [
      { label: "Open a countsheet", command: "cycle-count" },
      { label: "Create count sheet from template (no count sheet)", command: "cycle-count-from-template" },
      { label: "Add item location", command: "add-item-location" },
      { label: "Add new item to countsheet", command: "add-new-item" },
      { label: "Edit an item", command: "edit-item" },
      { label: "Post-submission UI validation", command: "post-submission-ui" },
      { label: "Cycle Count regression (add + edit + submit)", command: "cycle-count-smoke" },
    ],
  },
  {
    module: "Product Catalog",
    flows: [
      { label: "View catalog (smoke)", command: "product-catalog" },
      { label: "Filters sheet", command: "product-catalog-filters" },
      { label: "Product details", command: "product-catalog-details" },
      { label: "Add / Edit / Delete product", command: "product-catalog-add-edit-delete" },
      { label: "Filter refresh after product update", command: "pc-filter-refresh" },
      { label: "Product Catalog regression (all flows)", command: "product-catalog-regression" },
    ],
  },
  {
    module: "Invoice Scanning",
    flows: [
      { label: "Add invoice (upload + submit)", command: "upload-invoice" },
      { label: "Manage invoices (browse + open)", command: "invoice-scanning" },
      { label: "Landscape low-quality popup", command: "invoice-landscape-popup" },
      { label: "Invoice regression (add + manage + landscape)", command: "invoice-scanning-regression" },
    ],
  },
  {
    module: "Auth",
    flows: [
      { label: "Login only", command: "login-only" },
      { label: "Logout only", command: "logout-only" },
      { label: "Minimal smoke (login + inventory home + add location)", command: "minimal-smoke" },
    ],
  },
];

function JiraLink({ ticketKey, className, title }: { ticketKey: string; className?: string; title?: string }) {
  return (
    <a
      href={`${JIRA_BASE_URL}/${ticketKey}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {ticketKey}
    </a>
  );
}

function ConfettiOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const colors = ["#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#ff922b", "#cc5de8", "#f06595"];
    const particles = Array.from({ length: 140 }, (_, i) => ({
      x: (canvas.width * (i / 140)) + (Math.random() - 0.5) * 60,
      y: -10 - Math.random() * 120,
      w: 7 + Math.random() * 9,
      h: 4 + Math.random() * 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      vx: (Math.random() - 0.5) * 4,
      vy: 1.5 + Math.random() * 3.5,
      angle: Math.random() * Math.PI * 2,
      va: (Math.random() - 0.5) * 0.18,
      alpha: 1,
    }));
    let frame = 0;
    let animId = 0;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      frame++;
      let anyAlive = false;
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.04;
        p.angle += p.va;
        if (frame > 80) p.alpha -= 0.012;
        const a = Math.max(0, p.alpha);
        if (a > 0 && p.y < canvas.height + 20) {
          anyAlive = true;
          ctx.save();
          ctx.globalAlpha = a;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }
      }
      if (anyAlive) { animId = requestAnimationFrame(animate); }
      else { ctx.clearRect(0, 0, canvas.width, canvas.height); }
    };
    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, []);
  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 9999 }}
    />
  );
}

type JiraAttachState =
  | { status: "idle" }
  | { status: "attaching" }
  | { status: "done"; attached: number; total: number }
  | { status: "error"; message: string };

function AddToJiraPanel({
  runId,
  hasVideo,
  hasScreenshots,
  hasScenarios,
  jiraAttach,
  onAttach,
  defaultIssueKey,
}: {
  runId?: string;
  hasVideo: boolean;
  hasScreenshots: boolean;
  hasScenarios: boolean;
  jiraAttach: JiraAttachState;
  onAttach: (issueKey: string, opts: { attachVideo: boolean; attachScreenshots: boolean; attachScenarios: boolean }) => void;
  defaultIssueKey?: string;
}) {
  const [issueKey, setIssueKey] = useState(defaultIssueKey ?? "");
  const [attachVideo, setAttachVideo] = useState(true);
  const [attachScreenshots, setAttachScreenshots] = useState(true);
  const [attachScenarios, setAttachScenarios] = useState(true);

  if (!runId) return null;

  const nothingToAttach = !hasVideo && !hasScreenshots && !hasScenarios;
  if (nothingToAttach) return null;

  return (
    <div className="jira-attach-panel">
      <div className="subheading" style={{ marginTop: "1rem" }}>Add Evidence to Jira</div>
      <div className="jira-attach-row">
        <input
          className="jira-attach-input"
          type="text"
          placeholder="Ticket (e.g. SMB-1168)"
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value.toUpperCase())}
          disabled={jiraAttach.status === "attaching"}
        />
        <div className="jira-attach-checks">
          {hasScreenshots && (
            <label className="jira-attach-check">
              <input type="checkbox" checked={attachScreenshots} onChange={(e) => setAttachScreenshots(e.target.checked)} />
              Screenshots
            </label>
          )}
          {hasVideo && (
            <label className="jira-attach-check">
              <input type="checkbox" checked={attachVideo} onChange={(e) => setAttachVideo(e.target.checked)} />
              Video
            </label>
          )}
          {hasScenarios && (
            <label className="jira-attach-check">
              <input type="checkbox" checked={attachScenarios} onChange={(e) => setAttachScenarios(e.target.checked)} />
              Scenarios
            </label>
          )}
        </div>
        <button
          type="button"
          className="link-btn link-btn--attach"
          disabled={!issueKey.trim() || jiraAttach.status === "attaching"}
          onClick={() => onAttach(issueKey.trim(), { attachVideo, attachScreenshots, attachScenarios })}
        >
          {jiraAttach.status === "attaching" ? "Attaching…" : "↑ Add to Jira"}
        </button>
      </div>
      {jiraAttach.status === "done" && (
        <p className="bug-created-notice">
          ✓ Added {jiraAttach.attached} item{jiraAttach.attached !== 1 ? "s" : ""} to {issueKey}
        </p>
      )}
      {jiraAttach.status === "error" && (
        <p className="bug-error-notice">Failed: {jiraAttach.message}</p>
      )}
    </div>
  );
}

const JIRA_TICKET_INPUT_RE = /[A-Za-z][A-Za-z0-9_]+-\d+/g;

function BugBashPanel({
  bugBash,
  onStart,
  onCancel,
  isAgentRunning,
}: {
  bugBash: BugBashState;
  onStart: (tickets: string[]) => void;
  onCancel: () => void;
  isAgentRunning: boolean;
}) {
  const [inputValue, setInputValue] = useState("");
  const jiraBase = "https://jira.toasttab.com/browse";

  const parsedTickets = Array.from(
    new Set((inputValue.match(JIRA_TICKET_INPUT_RE) ?? []).map((t) => t.toUpperCase())),
  );

  const isRunning = bugBash.status === "running";
  const isDone = bugBash.status === "done";
  const passedCount = bugBash.results.filter((r) => r.passed).length;
  const failedCount = bugBash.results.filter((r) => !r.passed).length;

  return (
    <section className="panel">
      <div className="panel-title">
        Sprint Bug Bash
        {isRunning && (
          <div className="panel-title-actions">
            <span className="bugbash-progress-chip">
              {bugBash.currentIndex}/{bugBash.tickets.length}
            </span>
            <button type="button" className="link-btn rerun-btn" onClick={onCancel}>
              Stop
            </button>
          </div>
        )}
        {isDone && (
          <div className="panel-title-actions">
            <span className={`bugbash-summary-chip ${failedCount === 0 ? "bugbash-summary-chip--pass" : "bugbash-summary-chip--fail"}`}>
              {failedCount === 0 ? "✅" : "❌"} {passedCount}/{bugBash.results.length}
            </span>
            <button type="button" className="link-btn" onClick={() => setInputValue("")}>
              New Session
            </button>
          </div>
        )}
      </div>
      <div className="panel-body bugbash-body">
        {!isRunning && !isDone && (
          <>
            <p className="muted-small" style={{ marginBottom: "0.5rem" }}>
              Paste 10–15 sprint Jira ticket IDs (SMB-123, one per line or comma-separated).
              ToastPilot will test each one sequentially, attach evidence to Jira, and send a
              summary to Slack when done.
            </p>
            <textarea
              className="bugbash-textarea"
              placeholder={"SMB-1234\nSMB-1235\nSMB-1236"}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              rows={6}
            />
            {parsedTickets.length > 0 && (
              <div className="bugbash-parsed-chips">
                {parsedTickets.map((t) => (
                  <span key={t} className="bugbash-ticket-chip">{t}</span>
                ))}
              </div>
            )}
            <div className="bugbash-actions">
              <button
                type="button"
                className="primary"
                disabled={parsedTickets.length === 0 || isAgentRunning}
                onClick={() => onStart(parsedTickets)}
                title={isAgentRunning ? "Wait for the current agent run to finish first" : undefined}
              >
                Run Bug Bash ({parsedTickets.length} tickets)
              </button>
            </div>
          </>
        )}

        {isRunning && (
          <div className="bugbash-queue">
            {bugBash.tickets.map((ticketKey, i) => {
              const result = bugBash.results.find((r) => r.ticketKey === ticketKey);
              const isCurrent = bugBash.currentTicket === ticketKey;
              const isDoneTicket = Boolean(result);
              const icon = isDoneTicket
                ? (result!.passed ? "✅" : "❌")
                : isCurrent
                  ? "◎"
                  : "○";
              return (
                <div key={ticketKey} className={`bugbash-queue-row${isCurrent ? " bugbash-queue-row--active" : ""}${isDoneTicket ? (result!.passed ? " bugbash-queue-row--passed" : " bugbash-queue-row--failed") : ""}`}>
                  <span className="bugbash-queue-icon">{icon}</span>
                  <a
                    href={`${jiraBase}/${ticketKey}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bugbash-ticket-link"
                  >
                    {ticketKey}
                  </a>
                  {isDoneTicket && (
                    <span className="bugbash-steps-badge">
                      ✅{result!.stepsPassed} ❌{result!.stepsFailed}
                    </span>
                  )}
                  {isCurrent && <span className="bugbash-running-badge">Running…</span>}
                  <span className="bugbash-queue-num">{i + 1}</span>
                </div>
              );
            })}
          </div>
        )}

        {isDone && bugBash.results.length > 0 && (
          <>
            <div className="bugbash-summary-row">
              <span className="chip pass">Passed: {passedCount}</span>
              <span className="chip fail">Failed: {failedCount}</span>
              <span className="chip">Total: {bugBash.results.length}</span>
            </div>
            <div className="bugbash-results-list">
              {bugBash.results.map((r) => (
                <div key={r.ticketKey} className={`bugbash-result-row ${r.passed ? "bugbash-result-row--passed" : "bugbash-result-row--failed"}`}>
                  <span className="bugbash-result-icon">{r.passed ? "✅" : "❌"}</span>
                  <div className="bugbash-result-body">
                    <div className="bugbash-result-header">
                      <a
                        href={`${jiraBase}/${r.ticketKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bugbash-ticket-link"
                      >
                        {r.ticketKey}
                      </a>
                      {r.summary && <span className="bugbash-result-summary">{r.summary.slice(0, 70)}</span>}
                      <span className="bugbash-steps-badge">✅{r.stepsPassed} ❌{r.stepsFailed}</span>
                    </div>
                    {!r.passed && r.failureExplanation && (
                      <p className="bugbash-failure-text">{r.failureExplanation.slice(0, 160)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="muted-small" style={{ marginTop: "0.625rem" }}>
              Evidence (screenshots + video) attached to each Jira ticket. Aggregate Slack summary sent.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const { state, copilot, bugBash, connected, sendCommand, cancel, exportExecutiveSummary, startBugBash, cancelBugBash } =
    useAgentWebSocket();
  const { gitStatus, gitError, buildStatus, triggerBuild, refreshGitStatus } = useGitStatus();
  const [command, setCommand] = useState(DEMO_COMMAND);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const announcedRunIdRef = useRef<string | undefined>(undefined);
  const [showConfetti, setShowConfetti] = useState(false);

  const [flowMenuOpen, setFlowMenuOpen] = useState(false);
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  const [pinnedScreenshotIdx, setPinnedScreenshotIdx] = useState<number | null>(null);
  const [scenarioResults, setScenarioResults] = useState<Record<string, "running" | "passed" | "failed">>({});
  const activeScenarioIdRef = useRef<string | null>(null);
  const [bugCreation, setBugCreation] = useState<
    | { status: "idle" }
    | { status: "creating" }
    | { status: "created"; key: string; url: string }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const [jiraAttach, setJiraAttach] = useState<
    | { status: "idle" }
    | { status: "attaching" }
    | { status: "done"; attached: number; total: number }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const [slackReport, setSlackReport] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "sent" }
    | { status: "error"; message: string }
  >({ status: "idle" });

  useEffect(() => {
    if (state.status === "planning" || state.status === "booting") {
      setPinnedScreenshotIdx(null);
      setBugCreation({ status: "idle" });
      setJiraAttach({ status: "idle" });
      setSlackReport({ status: "idle" });
    }
  }, [state.status]);

  useEffect(() => {
    const id = activeScenarioIdRef.current;
    if (!id) return;
    if (state.status === "passed") {
      setScenarioResults((r) => ({ ...r, [id]: "passed" }));
      activeScenarioIdRef.current = null;
    } else if (state.status === "failed") {
      setScenarioResults((r) => ({ ...r, [id]: "failed" }));
      activeScenarioIdRef.current = null;
    } else if (state.status === "cancelled") {
      setScenarioResults((r) => { const n = { ...r }; delete n[id]; return n; });
      activeScenarioIdRef.current = null;
    }
  }, [state.status]);

  const latestScreenshot = state.screenshots[state.screenshots.length - 1];
  const displayedScreenshot =
    pinnedScreenshotIdx !== null ? state.screenshots[pinnedScreenshotIdx] : latestScreenshot;
  const failureAnalysis = state.failureAnalysis;
  const executiveSummary = state.executiveSummary;
  const featureAnalysis = copilot.featureAnalysis;
  const displayScenarios = copilot.scenarios.length > 0 ? copilot.scenarios : [];
  const steps = state.plan?.steps ?? [];
  const hasFailures = steps.some((s) => s.status === "failed");
  const passedNoFailures = state.status === "passed" && steps.length > 0 && !hasFailures;
  const isRunning = ["planning", "booting", "running", "healing"].includes(state.status);
  const canRerun = state.status === "failed" && Boolean(state.command.trim()) && !isRunning;
  const completionCopy = useMemo(
    () => getFlowCompletionCopy(state.plan?.flowId, state.plan?.flowName ?? state.command),
    [state.plan?.flowId, state.plan?.flowName, state.command],
  );

  const playClap = useCallback(async () => {
    try {
      const AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof window.AudioContext })
          .webkitAudioContext;
      if (!AudioContext) return;

      const ctx = new AudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
      }

      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(ctx.destination);

      // ── 1. Party horn — rising squawk sweep ──────────────────────
      const hornFreqs = [220, 330, 440, 587, 740, 880];
      hornFreqs.forEach((startHz, i) => {
        const t = now + i * 0.055;
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(startHz, t);
        osc.frequency.exponentialRampToValueAtTime(startHz * 1.6, t + 0.08);

        const dist = ctx.createWaveShaper();
        const curve = new Float32Array(256);
        for (let k = 0; k < 256; k++) {
          const x = (k * 2) / 256 - 1;
          curve[k] = ((Math.PI + 80) * x) / (Math.PI + 80 * Math.abs(x));
        }
        dist.curve = curve;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

        osc.connect(dist);
        dist.connect(g);
        g.connect(master);
        osc.start(t);
        osc.stop(t + 0.22);
      });

      // ── 2. Victory fanfare — three ascending major-chord tones ───
      const fanfareNotes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      fanfareNotes.forEach((freq, i) => {
        const t = now + 0.38 + i * 0.09;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = freq;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.45, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);

        osc.connect(g);
        g.connect(master);
        osc.start(t);
        osc.stop(t + 0.4);
      });

      // ── 3. Sparkle chime cascade — high glittery pings ───────────
      const chimeFreqs = [1568, 2093, 2637, 3136, 2349, 1760, 2093, 3136];
      chimeFreqs.forEach((freq, i) => {
        const t = now + 0.72 + i * 0.07;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.28, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

        osc.connect(g);
        g.connect(master);
        osc.start(t);
        osc.stop(t + 0.32);
      });

      await new Promise<void>((resolve) =>
        setTimeout(() => {
          void ctx.close().catch(() => undefined);
          resolve();
        }, 2000),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const startVoice = useCallback(() => {
    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: typeof window.SpeechRecognition })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition })
        .webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser. Use Chrome.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    recognitionRef.current = rec;

    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = e.results[0][0].transcript;
      setCommand(transcript);
      void sendCommand(transcript);
    };

    rec.start();
  }, [sendCommand]);

  const handleRerun = useCallback(() => {
    const cmd = state.command.trim() || command.trim();
    if (!cmd) return;
    setCommand(cmd);
    void sendCommand(cmd);
  }, [command, sendCommand, state.command]);

  const handleCreateJiraBug = useCallback(async () => {
    if (!executiveSummary) return;
    setBugCreation({ status: "creating" });

    const failedSteps = (state.plan?.steps ?? [])
      .filter((s) => s.status === "failed")
      .map((s) => s.description);

    const allSteps = (state.plan?.steps ?? []).map((s) => s.description);

    const issuesText = executiveSummary.issues.map((i) => `${i.title}: ${i.detail}`).join("\n");
    const failureDetail =
      state.failureExplanation ??
      (issuesText || "Test failed — see agent logs for details.");

    const summary = `[ToastPilot] ${executiveSummary.featureName} — ${
      failedSteps.length > 0
        ? `Failed: ${failedSteps[0].slice(0, 80)}`
        : "Automated test failure"
    }`;

    const body = {
      summary,
      description: failureDetail,
      stepsToReproduce: allSteps.length > 0 ? allSteps : ["Run the agent with command: " + executiveSummary.command],
      failureDetail,
      command: executiveSummary.command ?? state.command,
      runId: executiveSummary.runId,
      featureName: executiveSummary.featureName,
      priority: executiveSummary.risk === "High" ? "High" : "Medium",
      labels: ["automated-qa", executiveSummary.featureName.toLowerCase().replace(/\s+/g, "-")],
    };

    try {
      const res = await fetch("/api/jira/create-bug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { key?: string; url?: string; error?: string };
      if (!res.ok || data.error) {
        setBugCreation({ status: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setBugCreation({ status: "created", key: data.key!, url: data.url! });
    } catch (err) {
      setBugCreation({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [executiveSummary, state.failureExplanation, state.plan, state.command]);

  const handleAddToJira = useCallback(async (
    issueKey: string,
    opts: { attachVideo: boolean; attachScreenshots: boolean; attachScenarios: boolean },
  ) => {
    if (!state.id) return;
    setJiraAttach({ status: "attaching" });
    const total = (opts.attachVideo ? 1 : 0) + (opts.attachScreenshots ? state.screenshots.length : 0) + (opts.attachScenarios ? 1 : 0);
    try {
      const res = await fetch("/api/jira/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueKey,
          runId: state.id,
          attachVideo: opts.attachVideo,
          attachScreenshots: opts.attachScreenshots,
          attachScenarios: opts.attachScenarios,
          scenarios: displayScenarios.map((s) => ({ title: s.title, description: s.description, category: s.category })),
        }),
      });
      const data = await res.json() as { attached?: number; results?: unknown[]; error?: string };
      if (!res.ok || data.error) {
        setJiraAttach({ status: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setJiraAttach({ status: "done", attached: data.attached ?? 0, total });
    } catch (err) {
      setJiraAttach({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [state.id, state.screenshots.length, displayScenarios]);

  const handleSendSlackReport = useCallback(async () => {
    if (!executiveSummary) return;
    setSlackReport({ status: "sending" });
    try {
      const res = await fetch("/api/slack/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: executiveSummary.command ?? state.command,
          status: state.status,
          featureName: executiveSummary.featureName,
          risk: executiveSummary.risk,
          confidence: executiveSummary.confidenceScore,
          passed: executiveSummary.passed,
          failed: executiveSummary.failed,
          total: executiveSummary.generatedTests,
          recommendation: executiveSummary.recommendation,
          runId: state.id,
          environment: "Toast Operator Production · iPhone Simulator · Appium XCUITest",
          scenarios: displayScenarios.map((s) => ({ title: s.title, category: s.category })),
          jiraTicket: state.jiraContext?.ticketKey,
          jiraBugKey: bugCreation.status === "created" ? bugCreation.key : undefined,
          jiraBugUrl: bugCreation.status === "created" ? bugCreation.url : undefined,
          screenshotCount: state.screenshots.length,
          hasVideo: Boolean(state.videoPath),
        }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setSlackReport({ status: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setSlackReport({ status: "sent" });
    } catch (err) {
      setSlackReport({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [executiveSummary, state.command, state.status, state.id, state.jiraContext, state.screenshots.length, state.videoPath, displayScenarios, bugCreation]);

  useEffect(() => {
    return () => recognitionRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!passedNoFailures) return;
    if (!state.id) return;
    if (announcedRunIdRef.current === state.id) return;
    announcedRunIdRef.current = state.id;

    setShowConfetti(true);
    void playClap();
    const t = setTimeout(() => setShowConfetti(false), 4500);
    return () => clearTimeout(t);
  }, [passedNoFailures, playClap, state.id]);

  const stepIcon = (status: string) => {
    switch (status) {
      case "passed":
        return "✓";
      case "healed":
        return "⚡";
      case "failed":
        return "✗";
      case "running":
        return "◎";
      default:
        return "○";
    }
  };

  return (
    <>
    {showConfetti && <ConfettiOverlay />}
    <div className="app">
      <header className="header">
        <div>
          <h1>ToastPilot: Autonomous QA Agent for Unified Inventory</h1>
          <div className="subtitle">
            ToastUnifiedInventory · Real Operator App · Autonomous Simulator Testing
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <div className="git-status-row">
            {gitStatus ? (
              <>
                {!gitStatus.builtFromSha ? (
                  <span className="git-chip git-chip--behind" title="No build recorded yet — tap Build to build the app">
                    No build yet · {gitStatus.currentMainSha}
                  </span>
                ) : gitStatus.buildInProgress ? (
                  <span className="git-chip git-chip--building-log" title="Xcode build running…">
                    Building…
                  </span>
                ) : gitStatus.upToDate ? (
                  <span className="git-chip git-chip--ok" title={`Built from main · ${gitStatus.currentMainSha}\n${gitStatus.latestCommitMsg}`}>
                    ✓ Build up to date
                  </span>
                ) : (
                  <span
                    className="git-chip git-chip--behind"
                    title={`Built from: ${gitStatus.builtFromSha}\nLatest main: ${gitStatus.currentMainSha}\n${gitStatus.latestCommitMsg}`}
                  >
                    ↓ {gitStatus.newOnMainCount} new merge{gitStatus.newOnMainCount !== 1 ? "s" : ""} on main since build
                  </span>
                )}
              </>
            ) : (
              <span className="git-chip git-chip--loading">Checking build…</span>
            )}
            <button
              type="button"
              className={`build-btn${buildStatus.inProgress ? " building" : ""}`}
              onClick={() => void triggerBuild(false)}
              disabled={buildStatus.inProgress || state.status === "running" || state.status === "planning" || state.status === "booting"}
              title={buildStatus.inProgress ? "Building…" : "Build Toast Operator app for simulator"}
            >
              {buildStatus.inProgress ? "Building…" : "Build"}
            </button>
            <button
              type="button"
              className="git-refresh-btn"
              onClick={() => void refreshGitStatus()}
              title="Refresh git status"
            >
              ↺
            </button>
          </div>
          {(buildStatus.inProgress && buildStatus.lastLines) && (
            <span className="git-chip git-chip--building-log" title={buildStatus.lastLines}>
              {buildStatus.lastLines.split("\n").filter(Boolean).pop()?.slice(0, 55) ?? "Building…"}
            </span>
          )}
          {gitError && (
            <span className="git-chip git-chip--error" title={gitError}>git error</span>
          )}
          {buildStatus.error && (
            <span className="git-chip git-chip--error" title={buildStatus.error}>build failed</span>
          )}
          <span
            className="status-pill"
            style={{
              borderColor: connected ? "var(--green)" : "var(--muted)",
              color: connected ? "var(--green)" : "var(--muted)",
            }}
          >
            {connected ? "LIVE" : "OFFLINE"}
          </span>
          <span className={`status-pill ${state.status}`}>{state.status}</span>
        </div>
      </header>

      <div className="grid">
        <section className="panel">
          <div className="panel-title">Command Center</div>
          <div className="panel-body command-box">
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder='e.g. "Test Cycle Count flow" or a Jira ticket ID like SMB-1168'
            />
            <div className="command-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void sendCommand(command)}
                disabled={
                  state.status === "running" ||
                  state.status === "planning" ||
                  state.status === "booting" ||
                  state.status === "healing"
                }
              >
                Run Agent
              </button>
              <button
                type="button"
                className={listening ? "listening" : ""}
                onClick={startVoice}
              >
                🎤 Voice
              </button>
              <button type="button" onClick={() => setCommand(DEMO_COMMAND)}>
                Demo
              </button>
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={
                  state.status !== "running" &&
                  state.status !== "planning" &&
                  state.status !== "booting" &&
                  state.status !== "healing"
                }
                style={{
                  opacity:
                    state.status === "running" ||
                    state.status === "planning" ||
                    state.status === "booting" ||
                    state.status === "healing"
                      ? 1
                      : 0.35,
                }}
              >
                Cancel
              </button>
            </div>
            <div className="flow-browser-trigger">
              <button
                type="button"
                className={`flow-menu-toggle${flowMenuOpen ? " flow-menu-toggle--open" : ""}`}
                onClick={() => setFlowMenuOpen((v) => !v)}
                title="Browse all supported test flows"
              >
                <span className="flow-menu-toggle-icon">{flowMenuOpen ? "▲" : "▼"}</span>
                Browse Flows
                <span className="flow-menu-toggle-count">22</span>
              </button>
            </div>
            {flowMenuOpen && (
              <div className="flow-browser">
                <div className="flow-browser-header">
                  <span className="flow-browser-title">Test Flows</span>
                  <span className="flow-module-badge">{FLOW_MENU.reduce((n, m) => n + m.flows.length, 0)} flows</span>
                </div>
                {FLOW_MENU.map((mod) => (
                  <div key={mod.module} className="flow-module">
                    <button
                      type="button"
                      className="flow-module-header"
                      onClick={() =>
                        setExpandedModule((prev) =>
                          prev === mod.module ? null : mod.module,
                        )
                      }
                    >
                      <span className="flow-module-icon">{MODULE_ICONS[mod.module] ?? "▸"}</span>
                      <span className="flow-module-name">{mod.module}</span>
                      <span className="flow-module-badge">{mod.flows.length}</span>
                      <span className={`flow-module-chevron${expandedModule === mod.module ? " flow-module-chevron--open" : ""}`}>▼</span>
                    </button>
                    {expandedModule === mod.module && (
                      <ul className="flow-list">
                        {mod.flows.map((flow) => (
                          <li key={flow.label}>
                            <button
                              type="button"
                              className="flow-item-btn"
                              disabled={isRunning}
                              onClick={() => {
                                setFlowMenuOpen(false);
                                setCommand(flow.command);
                                void sendCommand(flow.command);
                              }}
                            >
                              <span className="flow-item-label">{flow.label}</span>
                              <span className="flow-item-id">{flow.command}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="chip-row">
              <span className="chip">ToastOperator.app</span>
              <span className="chip">Self-heal</span>
              {state.jiraContext && (
                <span className="chip chip-jira" title={state.jiraContext.rationale}>
                  🎫 <JiraLink ticketKey={state.jiraContext.ticketKey} />
                </span>
              )}
            </div>
            {state.jiraContext && (
              <div className="jira-context-card">
                <div className="jira-context-header">
                  <JiraLink ticketKey={state.jiraContext.ticketKey} className="jira-badge" />
                  <span className="jira-type">{state.jiraContext.issueType}</span>
                  <span className="jira-priority">{state.jiraContext.priority}</span>
                </div>
                <div className="jira-summary">{state.jiraContext.summary}</div>
                {state.jiraContext.acceptanceCriteria.length > 0 && (
                  <details className="jira-ac-details">
                    <summary className="jira-ac-summary">
                      Acceptance criteria ({state.jiraContext.acceptanceCriteria.length})
                    </summary>
                    <ol className="jira-ac-list">
                      {state.jiraContext.acceptanceCriteria.map((ac, i) => (
                        <li key={i}>{ac}</li>
                      ))}
                    </ol>
                  </details>
                )}
                <div className="jira-rationale">{state.jiraContext.rationale}</div>
              </div>
            )}
            {state.plan && (
              <>
                <div className="plan-label">
                  Plan: <strong>{state.plan.flowName || state.command}</strong>
                </div>
                <ul className="steps">
                  {state.plan.steps.map((step, i) => (
                    <li key={step.id}>
                      <span className={`step-icon ${step.status}`}>{stepIcon(step.status)}</span>
                      <span>
                        {i + 1}. {step.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {state.healingEvents.map((h) => (
              <div key={h.stepId + h.healedSelector} className="heal-card">
                <strong>Self-heal</strong> ({h.strategy})
                <br />
                {h.originalSelector} → {h.healedSelector}
                {h.aiReason && <div style={{ marginTop: 4, opacity: 0.85 }}>{h.aiReason}</div>}
              </div>
            ))}
          </div>
        </section>

        <div className="feed-column">
          <section className="panel feed-panel">
            <div className="panel-title">
              Live Simulator Feed
              {state.screenshots.length > 0 && (
                <div className="panel-title-actions">
                  <span className="muted-small" style={{ fontSize: "var(--text-xs)" }}>
                    {pinnedScreenshotIdx !== null
                      ? `Step ${pinnedScreenshotIdx + 1} of ${state.screenshots.length}`
                      : `${state.screenshots.length} screenshot${state.screenshots.length !== 1 ? "s" : ""}`}
                  </span>
                  {pinnedScreenshotIdx !== null && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setPinnedScreenshotIdx(null)}
                    >
                      Follow live
                    </button>
                  )}
                  {displayedScreenshot?.base64Preview && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        const raw = displayedScreenshot.base64Preview!;
                        const b64 = raw.includes(",") ? raw.split(",")[1] : raw;
                        try {
                          const bytes = atob(b64);
                          const arr = new Uint8Array(bytes.length);
                          for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                          const url = URL.createObjectURL(new Blob([arr], { type: "image/png" }));
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${displayedScreenshot.label.replace(/\s+/g, "_")}.png`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          setTimeout(() => URL.revokeObjectURL(url), 10000);
                        } catch {
                          // fallback: open in new tab
                          window.open(`data:image/png;base64,${b64}`, "_blank");
                        }
                      }}
                    >
                      ↓ Save
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="panel-body screenshot-feed-body">
              <div className="screenshot-frame">
                {displayedScreenshot?.base64Preview ? (
                  <>
                    <img
                      src={displayedScreenshot.base64Preview}
                      alt={displayedScreenshot.label}
                    />
                    <div className="screenshot-label">{displayedScreenshot.label}</div>
                  </>
                ) : (
                  <span className="screenshot-placeholder">
                    Screenshots appear as the agent navigates real ToastUnifiedInventory screens
                  </span>
                )}
              </div>
              {state.screenshots.length > 0 && (
                <div className="screenshot-filmstrip">
                  {state.screenshots.map((shot, idx) => (
                    <button
                      key={shot.stepId + idx}
                      type="button"
                      className={`filmstrip-thumb${pinnedScreenshotIdx === idx || (pinnedScreenshotIdx === null && idx === state.screenshots.length - 1) ? " active" : ""}`}
                      onClick={() =>
                        setPinnedScreenshotIdx(
                          idx === state.screenshots.length - 1 && pinnedScreenshotIdx === null
                            ? null
                            : idx,
                        )
                      }
                      title={shot.label}
                    >
                      {shot.base64Preview ? (
                        <img src={shot.base64Preview} alt={shot.label} />
                      ) : (
                        <span className="filmstrip-num">{idx + 1}</span>
                      )}
                      <span className="filmstrip-label">{idx + 1}</span>
                    </button>
                  ))}
                </div>
              )}
              {state.videoPath && (
                <div className="video-recording-section">
                  <div className="video-recording-label">
                    ⏺ Run Recording
                    <a
                      href={`/api/artifacts/${state.id}/recording.mp4`}
                      download="recording.mp4"
                      className="link-btn"
                      style={{ marginLeft: "0.5rem" }}
                    >
                      ↓ Download
                    </a>
                  </div>
                  <video
                    className="video-recording-player"
                    src={`/api/artifacts/${state.id}/recording.mp4`}
                    controls
                    playsInline
                  />
                </div>
              )}
              {passedNoFailures && (
                <div className="explanation success">
                  <strong>{completionCopy.heading}</strong>
                  <p style={{ margin: "0.5rem 0 0" }}>{completionCopy.message}</p>
                </div>
              )}
            </div>
          </section>

          <section className="panel failure-panel">
            <div className="panel-title">
              AI Failure Analysis
              {canRerun && (
                <div className="panel-title-actions">
                  <button type="button" className="link-btn rerun-btn" onClick={handleRerun}>
                    Rerun
                  </button>
                </div>
              )}
            </div>
            <div className="panel-body">
              {failureAnalysis ? (
                <div className="failure-analysis">
                  <p>
                    <strong>Failure Detected</strong>
                  </p>
                  <p>
                    <strong>Assertion:</strong> {failureAnalysis.assertion}
                  </p>
                  {failureAnalysis.expected && (
                    <p>
                      <strong>Expected:</strong> {failureAnalysis.expected}
                    </p>
                  )}
                  {failureAnalysis.actual && (
                    <p>
                      <strong>Actual:</strong> {failureAnalysis.actual}
                    </p>
                  )}
                  <p>
                    <strong>Possible Cause:</strong> {failureAnalysis.possibleCause}
                  </p>
                  <p>
                    <strong>Diagnosis Confidence:</strong> {failureAnalysis.confidencePercent}%
                  </p>
                  {failureAnalysis.logExcerpt && failureAnalysis.logExcerpt.length > 0 && (
                    <div className="log-excerpt">
                      {failureAnalysis.logExcerpt.slice(-5).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </div>
                  )}
                  {canRerun && (
                    <button type="button" className="primary rerun-action" onClick={handleRerun}>
                      Rerun test
                    </button>
                  )}
                </div>
              ) : state.failureExplanation ? (
                <>
                  <p>{state.failureExplanation}</p>
                  {canRerun && (
                    <button type="button" className="primary rerun-action" onClick={handleRerun}>
                      Rerun test
                    </button>
                  )}
                </>
              ) : (
                <p className="muted-small">No failures in this run yet.</p>
              )}
            </div>
          </section>

          <BugBashPanel
            bugBash={bugBash}
            onStart={(tickets) => void startBugBash(tickets)}
            onCancel={() => void cancelBugBash()}
            isAgentRunning={isRunning}
          />
        </div>

        <section className="panel">
          <div className="panel-title">Agent Log Stream</div>
          <div className="panel-body log-stream">
            {state.logs.length === 0 && (
              <div className="muted-small">Waiting for agent activity…</div>
            )}
            {[...state.logs].reverse().map((log) => (
              <div key={log.id} className={`log-line ${log.level}`}>
                <span className="log-time">
                  {new Date(log.timestamp).toLocaleTimeString()}{" "}
                </span>
                {log.message}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="leadership-grid">
        <section className="panel leadership-panel">
          <div className="panel-title">Feature Analysis</div>
          <div className="panel-body">
            {featureAnalysis ? (
              <>
                <div className="metric-row">
                  <span className="chip">Feature: {featureAnalysis.featureName}</span>
                  <span className="chip">Module: {featureAnalysis.impactedModule}</span>
                  <span
                    className={`chip risk-${featureAnalysis.risk.toLowerCase()}`}
                    title="Area Risk: how critical this feature area is to the product (independent of test confidence)"
                  >
                    Area Risk: {featureAnalysis.risk}
                  </span>
                </div>
                <p className="muted-small">
                  {featureAnalysis.changedFiles.length > 0
                    ? `${featureAnalysis.changedFiles.length} changed file(s) · `
                    : "No repo files impacted · "}
                  Flow match confidence: {toConfidencePercent(featureAnalysis.confidenceScore)}% <span className="muted-small" title="How confidently the command matched a known test flow">(command → flow)</span>
                </p>
                <ul className="compact-list">
                  {featureAnalysis.impactedAreas.map((a) => (
                    <li key={a.area}>
                      <strong>{a.area}</strong> — {a.risk} · {a.reason}
                    </li>
                  ))}
                </ul>
              </>
            ) : displayScenarios.length === 0 ? (
              <p className="muted-small">
                Run a command to see feature impact analysis aligned to your test plan.
              </p>
            ) : null}
            {(featureAnalysis || displayScenarios.length > 0) && (
              <>
                <div className="subheading" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Generated Test Scenarios</span>
                  {displayScenarios.length > 0 && (
                    <button
                      type="button"
                      className="link-btn"
                      style={{ fontSize: "0.75rem" }}
                      onClick={() => {
                        const header = "ID,Category,Title,Description,Flow\n";
                        const rows = displayScenarios.map((s) =>
                          [s.id, s.category, `"${s.title.replace(/"/g, '""')}"`, `"${(s.description ?? "").replace(/"/g, '""')}"`, s.mappedFlowId ?? ""].join(",")
                        ).join("\n");
                        const blob = new Blob([header + rows], { type: "text/csv" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `test-scenarios-${copilot.recommendedCommand?.replace(/\s+/g, "-").toLowerCase() ?? "run"}.csv`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      title="Download scenarios as CSV to attach to Jira"
                    >
                      ↓ Download CSV
                    </button>
                  )}
                </div>
                {displayScenarios.length === 0 ? (
                  <p className="muted-small">
                    Scenarios appear when you run a command — positive, negative and edge cases based on the Jira ticket or command.
                  </p>
                ) : (
                  <ol className="scenario-list">
                    {displayScenarios.map((s) => {
                      const result = scenarioResults[s.id];
                      const isThisRunning = result === "running";
                      return (
                        <li key={s.id} className={`scenario-item${result === "passed" ? " scenario-item--passed" : result === "failed" ? " scenario-item--failed" : ""}`}>
                          <div className="scenario-header">
                            <span className={`scenario-badge scenario-badge--${s.category}`}>
                              {s.category === "happy_path" ? "Positive" : s.category === "negative" ? "Negative" : s.category === "edge" ? "Edge" : s.category}
                            </span>
                            <span className="scenario-title">{s.title.replace(/^\[(Positive|Negative|Edge|Role_based|Permission)\]\s*/i, "")}</span>
                            <div className="scenario-actions">
                              {result === "passed" && <span className="scenario-result scenario-result--passed">✓ Passed</span>}
                              {result === "failed" && <span className="scenario-result scenario-result--failed">✗ Failed</span>}
                              {s.automatable && !result && (
                                <button
                                  type="button"
                                  className="scenario-test-btn"
                                  disabled={isRunning || Boolean(activeScenarioIdRef.current)}
                                  onClick={() => {
                                    if (!s.testCommand) return;
                                    activeScenarioIdRef.current = s.id;
                                    setScenarioResults((r) => ({ ...r, [s.id]: "running" }));
                                    void sendCommand(s.testCommand, undefined, s.stepActions);
                                  }}
                                  title="Run only the steps needed for this scenario"
                                >
                                  {isThisRunning ? "Running…" : "▶ Test"}
                                </button>
                              )}
                              {!s.automatable && !result && (
                                <span className="scenario-manual-tag" title="This scenario requires manual testing">Manual</span>
                              )}
                            </div>
                          </div>
                          {s.description && (
                            <p className="scenario-desc">{s.description}</p>
                          )}
                          {s.mappedFlowId && (
                            <span className="muted-small">flow: {s.mappedFlowId}</span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {copilot.recommendedCommand && (
                  <p className="muted-small" style={{ marginTop: "0.75rem" }}>
                    Mapped command: <strong>{copilot.recommendedCommand}</strong>
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        <section className="panel leadership-panel">
          <div className="panel-title">
            Executive Summary
            {(executiveSummary || canRerun) && (
              <div className="panel-title-actions">
                {canRerun && (
                  <button type="button" className="link-btn rerun-btn" onClick={handleRerun}>
                    Rerun
                  </button>
                )}
                {executiveSummary && (
                  <button type="button" className="link-btn" onClick={() => void exportExecutiveSummary()}>
                    Export JSON
                  </button>
                )}
                {executiveSummary && executiveSummary.failed > 0 && (
                  <button
                    type="button"
                    className="link-btn link-btn--bug"
                    disabled={bugCreation.status === "creating" || bugCreation.status === "created"}
                    onClick={() => void handleCreateJiraBug()}
                    title="Create a Jira bug ticket from this failure"
                  >
                    {bugCreation.status === "creating"
                      ? "Creating…"
                      : bugCreation.status === "created"
                        ? `✓ ${bugCreation.key}`
                        : "⬡ Create Jira Bug"}
                  </button>
                )}
                {executiveSummary && (
                  <button
                    type="button"
                    className="link-btn link-btn--slack"
                    disabled={slackReport.status === "sending" || slackReport.status === "sent"}
                    onClick={() => void handleSendSlackReport()}
                    title="Send QA report to Slack"
                  >
                    {slackReport.status === "sending"
                      ? "Sending…"
                      : slackReport.status === "sent"
                        ? "✓ Sent to Slack"
                        : "⬡ Send Slack Report"}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="panel-body">
            {executiveSummary ? (
              <>
                <div className="metric-row">
                  <span className="chip">Generated: {executiveSummary.generatedTests}</span>
                  <span className="chip pass">Passed: {executiveSummary.passed}</span>
                  <span className="chip fail">Failed: {executiveSummary.failed}</span>
                </div>
                <p>
                  <strong>Feature:</strong> {executiveSummary.featureName}
                </p>
                <p>
                  <strong>Test Confidence:</strong>{" "}
                  {toConfidencePercent(executiveSummary.confidenceScore)}% · <strong>Risk:</strong> {executiveSummary.risk}
                </p>
                {executiveSummary.issues.length > 0 && (
                  <ul className="compact-list">
                    {executiveSummary.issues.map((issue, i) => (
                      <li key={issue.title + i}>
                        <strong>Issue {i + 1}:</strong> {issue.title}
                        <div className="muted-small">{issue.detail}</div>
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  <strong>Recommendation:</strong> {executiveSummary.recommendation}
                </p>
                {bugCreation.status === "created" && (
                  <p className="bug-created-notice">
                    Bug filed:{" "}
                    <a href={bugCreation.url} target="_blank" rel="noopener noreferrer" className="bug-created-link">
                      {bugCreation.key}
                    </a>
                    {" "}— open in Jira
                  </p>
                )}
                {bugCreation.status === "error" && (
                  <p className="bug-error-notice">
                    Failed to create Jira bug: {bugCreation.message}
                  </p>
                )}
                {slackReport.status === "error" && (
                  <p className="bug-error-notice">
                    Failed to send Slack report: {slackReport.message}
                  </p>
                )}
                <AddToJiraPanel
                  runId={state.id}
                  hasVideo={Boolean(state.videoPath)}
                  hasScreenshots={state.screenshots.length > 0}
                  hasScenarios={displayScenarios.length > 0}
                  jiraAttach={jiraAttach}
                  onAttach={handleAddToJira}
                  defaultIssueKey={state.jiraContext?.ticketKey}
                />
              </>
            ) : (
              <p className="muted-small">Executive summary appears when a run completes.</p>
            )}
            {copilot.reasoning.length > 0 && (
              <>
                <div className="subheading">Strategic Insight Trace</div>
                <div className="insight-trace-feed">
                  {copilot.reasoning.slice(-6).map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
    </>
  );
}
