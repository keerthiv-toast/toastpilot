import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  AgentRunState,
  BugBashState,
  CopilotDashboardState,
  ExecutiveSummaryView,
  FeatureAnalysisView,
  GeneratedScenarioView,
  JiraContext,
  LogEntry,
} from "../types";
import { toConfidencePercent } from "../confidence";

const initialState: AgentRunState = {
  status: "idle",
  command: "",
  currentStepIndex: -1,
  healingEvents: [],
  screenshots: [],
  logs: [],
  videoPath: undefined,
};

const initialCopilot: CopilotDashboardState = {
  scenarios: [],
  recommendedCommand: "",
  reasoning: [],
};

type ServerRun = {
  id?: string;
  status?: AgentRunState["status"];
  command?: string;
  plan?: AgentRunState["plan"];
  currentStepIndex?: number;
  healingEvents?: AgentRunState["healingEvents"];
  screenshots?: AgentRunState["screenshots"];
  logs?: LogEntry[];
  failureExplanation?: string;
  failureAnalysis?: AgentRunState["failureAnalysis"];
  executiveSummary?: ExecutiveSummaryView;
  videoPath?: string;
};

function mergeRunIntoState(prev: AgentRunState, run: ServerRun): AgentRunState {
  return {
    ...prev,
    id: run.id ?? prev.id,
    status: run.status ?? prev.status,
    command: run.command ?? prev.command,
    plan: run.plan ?? prev.plan,
    currentStepIndex: run.currentStepIndex ?? prev.currentStepIndex,
    healingEvents: run.healingEvents ?? prev.healingEvents,
    screenshots: run.screenshots ?? prev.screenshots,
    logs: run.logs?.length ? run.logs : prev.logs,
    failureExplanation: run.failureExplanation ?? prev.failureExplanation,
    failureAnalysis: run.failureAnalysis ?? prev.failureAnalysis,
    executiveSummary: run.executiveSummary ?? prev.executiveSummary,
    videoPath: run.videoPath ?? prev.videoPath,
  };
}

function normalizeExecutiveSummary(raw: Record<string, unknown>): ExecutiveSummaryView {
  const issues = (raw.issues as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    runId: String(raw.runId ?? ""),
    command: String(raw.command ?? ""),
    featureName: String(raw.featureName ?? "ToastUnifiedInventory"),
    module: String(raw.module ?? "ToastUnifiedInventory"),
    risk: String(raw.risk ?? "Medium"),
    passed: Number(raw.passed ?? 0),
    failed: Number(raw.failed ?? 0),
    generatedTests: Number(raw.generatedTests ?? 0),
    confidenceScore: Number(raw.confidenceScore ?? 0),
    recommendation: String(raw.recommendation ?? ""),
    issues: issues.map((i) => ({ title: String(i.title ?? ""), detail: String(i.detail ?? "") })),
    status: raw.status != null ? String(raw.status) : undefined,
    exportedAt: raw.exportedAt != null ? String(raw.exportedAt) : undefined,
  };
}

function normalizeFeatureAnalysis(raw: Record<string, unknown>): FeatureAnalysisView {
  const areas = (raw.impactedAreas as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    featureName: String(raw.featureName ?? "ToastUnifiedInventory"),
    impactedModule: String(raw.impactedModule ?? "ToastUnifiedInventory"),
    risk: String(raw.risk ?? "Medium"),
    changedFiles: (raw.changedFiles as string[] | undefined) ?? [],
    impactedAreas: areas.map((a) => ({
      area: String(a.area ?? ""),
      risk: String(a.risk ?? ""),
      reason: String(a.reason ?? ""),
    })),
    newWorkflows: (raw.newWorkflows as string[] | undefined) ?? [],
    confidenceScore: toConfidencePercent(Number(raw.confidenceScore), 85),
  };
}

const initialBugBash: BugBashState = {
  status: "idle",
  tickets: [],
  results: [],
  currentIndex: -1,
};

export function useAgentWebSocket() {
  const [state, setState] = useState<AgentRunState>(initialState);
  const [copilot, setCopilot] = useState<CopilotDashboardState>(initialCopilot);
  const [bugBash, setBugBash] = useState<BugBashState>(initialBugBash);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const pendingCommandRef = useRef<string>("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoPollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadPreflight = useCallback(async (command?: string) => {
    try {
      const res = await fetch("/api/copilot/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command?.trim() ?? "" }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        featureAnalysis: Record<string, unknown>;
        scenarios: GeneratedScenarioView[];
        recommendedCommand: string;
      };
      setCopilot((prev) => ({
        ...prev,
        featureAnalysis: normalizeFeatureAnalysis(data.featureAnalysis),
        scenarios: data.scenarios ?? [],
        recommendedCommand: data.recommendedCommand ?? "",
      }));
    } catch {
      /* ignore */
    }
  }, []);

  const hydrateFromServer = useCallback(async (expectedCommand?: string) => {
    try {
      const res = await fetch("/api/runs/current");
      if (!res.ok) return;
      const run = (await res.json()) as ServerRun | null;
      if (!run?.id) return;

      const expected = (expectedCommand ?? pendingCommandRef.current).trim();
      if (expected && run.command && run.command.trim() !== expected) {
        return;
      }

      setState((prev) => {
        if (
          activeRunIdRef.current &&
          run.id !== activeRunIdRef.current &&
          prev.command?.trim() === expected
        ) {
          return prev;
        }
        if (run.id) activeRunIdRef.current = run.id;
        return mergeRunIntoState(prev, run);
      });
    } catch {
      /* ignore */
    }
  }, []);

  const startPolling = useCallback(
    (command: string) => {
      stopPolling();
      pollTimerRef.current = setInterval(() => {
        void hydrateFromServer(command);
      }, 600);
    },
    [hydrateFromServer, stopPolling],
  );

  const applyEvent = useCallback(
    (event: AgentEvent) => {
      if (event.type === "history") {
        for (const e of event.events) {
          if ((e as AgentEvent).type !== "history") applyEvent(e as AgentEvent);
        }
        void hydrateFromServer();
        return;
      }

      if (event.type === "copilot:feature-analysis") {
        setCopilot((prev) => ({
          ...prev,
          featureAnalysis: normalizeFeatureAnalysis(event.analysis as unknown as Record<string, unknown>),
        }));
        return;
      }
      if (event.type === "copilot:scenarios") {
        setCopilot((prev) => ({
          ...prev,
          scenarios: event.scenarios,
          recommendedCommand: event.recommendedCommand,
        }));
        return;
      }
      if (event.type === "copilot:reasoning") {
        setCopilot((prev) => ({
          ...prev,
          reasoning: [...prev.reasoning.slice(-24), event.message],
        }));
        return;
      }
      if (event.type === "copilot:executive-summary") {
        setState((prev) => ({
          ...prev,
          executiveSummary: normalizeExecutiveSummary(event.report as unknown as Record<string, unknown>),
        }));
        return;
      }

      setState((prev) => {
        const incomingRunId =
          event.type === "run:started"
            ? event.run.id
            : event.type === "run:finished"
              ? event.run.id
              : "runId" in event
                ? (event as { runId?: string }).runId
                : undefined;

        const activeId = activeRunIdRef.current;

        if (
          activeId &&
          incomingRunId &&
          incomingRunId !== activeId &&
          event.type !== "run:started"
        ) {
          return prev;
        }

        const next = { ...prev };

        switch (event.type) {
          case "run:started": {
            activeRunIdRef.current = event.run.id;
            stopPolling();
            return {
              ...initialState,
              id: event.run.id,
              command: event.run.command,
              status: event.run.status,
              jiraContext: event.run.jiraContext,
            };
          }
          case "run:status":
            return { ...next, status: event.status };
          case "plan:generated":
            return { ...next, plan: event.plan, command: event.plan.command ?? next.command };
          case "step:started": {
            const steps = next.plan?.steps.map((s, i) =>
              i === event.index ? { ...s, status: "running" as const } : s,
            );
            return {
              ...next,
              currentStepIndex: event.index,
              plan: next.plan ? { ...next.plan, steps: steps ?? [] } : next.plan,
            };
          }
          case "step:finished": {
            const steps = next.plan?.steps.map((s, i) =>
              i === event.index ? { ...s, status: event.step.status, error: event.step.error } : s,
            );
            return {
              ...next,
              plan: next.plan ? { ...next.plan, steps: steps ?? [] } : next.plan,
            };
          }
          case "step:healing":
            return {
              ...next,
              status: "healing",
              healingEvents: [...next.healingEvents, event.event],
            };
          case "log":
            return { ...next, logs: [...next.logs.slice(-200), event.entry] };
          case "screenshot":
            return { ...next, screenshots: [...next.screenshots, event.artifact] };
          case "failure:explained":
            return { ...next, failureExplanation: event.explanation };
          case "failure:analysis":
            return { ...next, failureAnalysis: event.analysis };
          case "run:finished":
            stopPolling();
            return {
              ...next,
              status: event.run.status,
              failureExplanation: event.run.failureExplanation ?? next.failureExplanation,
              videoPath: event.run.videoPath ?? next.videoPath,
            };
          default:
            return next;
        }
      });

      // Bug bash events
      if (event.type === "bugbash:started") {
        setBugBash({ status: "running", sessionId: event.sessionId, tickets: event.tickets, results: [], currentIndex: 0 });
        return;
      }
      if (event.type === "bugbash:ticket:started") {
        setBugBash((prev) => ({ ...prev, currentIndex: event.index, currentTicket: event.ticketKey }));
        return;
      }
      if (event.type === "bugbash:ticket:finished") {
        setBugBash((prev) => ({
          ...prev,
          currentIndex: event.index + 1,
          currentTicket: undefined,
          results: [
            ...prev.results,
            {
              ticketKey: event.ticketKey,
              passed: event.passed,
              runId: event.runId,
              stepsPassed: 0,
              stepsFailed: 0,
              screenshotCount: 0,
              hasVideo: false,
            },
          ],
        }));
        return;
      }
      if (event.type === "bugbash:finished") {
        setBugBash((prev) => ({ ...prev, status: "done", results: event.results, currentTicket: undefined }));
        return;
      }
      if (event.type === "bugbash:cancelled") {
        setBugBash((prev) => ({ ...prev, status: "cancelled", currentTicket: undefined }));
        return;
      }

      // Video poller: if run finished without a videoPath, simctl may still be flushing.
      // Schedule outside setState to avoid React StrictMode double-invocation.
      // Guard against StrictMode double-fire: only start if no poller is already active.
      if (event.type === "run:finished" && !event.run.videoPath) {
        if (videoPollerRef.current) return;
        let attempts = 0;
        videoPollerRef.current = setInterval(() => {
          attempts++;
          void hydrateFromServer();
          if (attempts >= 30) {
            clearInterval(videoPollerRef.current!);
            videoPollerRef.current = null;
          }
        }, 500);
      }
    },
    [hydrateFromServer, stopPolling],
  );

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const ws = new WebSocket(`${protocol}//${host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setConnected(true);
        void hydrateFromServer();
        if (pendingCommandRef.current) {
          void loadPreflight(pendingCommandRef.current);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        // Exponential back-off: 1s, 2s, 4s, … capped at 30s
        const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 30_000);
        reconnectAttemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onmessage = (msg) => {
        try {
          applyEvent(JSON.parse(msg.data) as AgentEvent);
        } catch {
          /* ignore */
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (videoPollerRef.current) {
        clearInterval(videoPollerRef.current);
        videoPollerRef.current = null;
      }
      stopPolling();
      wsRef.current?.close();
    };
  }, [applyEvent, hydrateFromServer, loadPreflight, stopPolling]);

  const analyzeJiraTicket = useCallback(
    async (
      ticketKey: string,
    ): Promise<{
      command: string;
      flowId: string;
      rationale: string;
      acceptanceCriteria: string[];
      jiraContext: JiraContext;
      summary: string;
      issueType: string;
      priority: string;
    } | null> => {
      try {
        const res = await fetch("/api/jira/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketKey: ticketKey.trim().toUpperCase() }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: res.statusText }))) as {
            error?: string;
          };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as {
          command: string;
          flowId: string;
          rationale: string;
          acceptanceCriteria: string[];
          jiraContext: JiraContext;
          summary: string;
          issueType: string;
          priority: string;
        };
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [],
  );

  const sendCommand = useCallback(
    async (command: string, jiraContext?: JiraContext, stepActions?: string[]) => {
      const trimmed = command.trim();
      if (!trimmed) return;

      const JIRA_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
      const jiraMatch = JIRA_RE.exec(trimmed);
      let resolvedCommand = trimmed;
      let resolvedContext = jiraContext;

      if (jiraMatch && !jiraContext) {
        const ticketKey = jiraMatch[1];
        let resolveError: string | null = null;
        try {
          const result = await analyzeJiraTicket(ticketKey);
          if (result) {
            resolvedCommand = result.command;
            resolvedContext = result.jiraContext;
          } else {
            resolveError = `Could not synthesise a test plan for ${ticketKey}.`;
          }
        } catch (err) {
          resolveError = err instanceof Error ? err.message : String(err);
        }

        if (resolveError) {
          setState({
            ...initialState,
            command: trimmed,
            status: "failed",
            logs: [{
              id: `local-${Date.now()}`,
              level: "error",
              message: `Jira lookup failed for ${ticketKey}: ${resolveError}`,
              timestamp: new Date().toISOString(),
            }],
            failureExplanation: `Could not resolve Jira ticket "${ticketKey}": ${resolveError}. Configure JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN in .env to use ticket IDs as commands.`,
          });
          return;
        }
      }

      pendingCommandRef.current = resolvedCommand;
      activeRunIdRef.current = undefined;
      stopPolling();

      const bootLog: LogEntry = {
        id: `local-${Date.now()}`,
        level: "agent",
        message: resolvedContext
          ? `Jira ${resolvedContext.ticketKey}: "${resolvedCommand}"`
          : `Received command: "${resolvedCommand}"`,
        timestamp: new Date().toISOString(),
      };

      setState({
        ...initialState,
        command: resolvedCommand,
        status: "planning",
        logs: [bootLog],
        jiraContext: resolvedContext,
      });

      void loadPreflight(resolvedCommand);

      await fetch("/api/commands/cancel", { method: "POST" });
      await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: resolvedCommand, jiraContext: resolvedContext, stepActions }),
      });

      startPolling(resolvedCommand);
      void hydrateFromServer(resolvedCommand);
    },
    [analyzeJiraTicket, hydrateFromServer, loadPreflight, startPolling, stopPolling],
  );

  const cancel = useCallback(async () => {
    pendingCommandRef.current = "";
    activeRunIdRef.current = undefined;
    stopPolling();
    setState((prev) =>
      prev.status === "running" ||
      prev.status === "planning" ||
      prev.status === "booting" ||
      prev.status === "healing"
        ? { ...prev, status: "cancelled" }
        : prev,
    );
    await fetch("/api/commands/cancel", { method: "POST" }).catch(() => undefined);
  }, [stopPolling]);

  const startBugBash = useCallback(async (tickets: string[]) => {
    const valid = tickets.map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (valid.length === 0) return;
    setBugBash({ status: "running", tickets: valid, results: [], currentIndex: 0 });
    await fetch("/api/bug-bash/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickets: valid }),
    }).catch(() => undefined);
  }, []);

  const cancelBugBash = useCallback(async () => {
    setBugBash((prev) => ({ ...prev, status: "cancelled" }));
    await fetch("/api/bug-bash/cancel", { method: "POST" }).catch(() => undefined);
  }, []);

  const exportExecutiveSummary = useCallback(async () => {
    if (!state.id) return;
    window.open(`/api/reports/${state.id}/executive-summary.json`, "_blank");
  }, [state.id]);

  return {
    state,
    copilot,
    bugBash,
    connected,
    sendCommand,
    cancel,
    loadPreflight,
    exportExecutiveSummary,
    startBugBash,
    cancelBugBash,
  };
};
