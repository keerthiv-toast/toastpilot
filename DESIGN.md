# ToastPilot — Technical Design

This document is the full technical design. For a feature overview see the README, and for the hackathon pitch see HACKATHON.md.

---

## Overview

ToastPilot is a fully autonomous AI QA agent purpose-built for the Toast Operator iOS app's Unified Inventory module. It connects a GitHub PR-merge webhook (or a dashboard command) to an end-to-end pipeline that synthesizes a test plan from Jira ticket context, drives the real Toast Operator Production simulator via Appium/XCUITest, self-heals broken selectors at runtime, captures screenshots and screen recordings, and writes results back to Jira and Slack — all without human intervention. The system covers three iOS modules (Cycle Count, Product Catalog, Invoice Scanning), ships 22 ready-to-run test flows across 14,320 lines of TypeScript, and exposes a React dashboard for live monitoring and manual control.

---

## System Architecture

```
External Triggers
─────────────────────────────────────────────────────────────────────────────
  GitHub PR merge ──────────────────────────────────┐
  Dashboard command (HTTP POST /api/commands) ──────┤
  Bug Bash request  (HTTP POST /api/bug-bash/start) ┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              Server & Orchestration Layer               │
│  Express + WebSocket  (port 9477)                       │
│                                                         │
│  ┌────────────────┐   ┌──────────────┐                  │
│  │ HMAC Webhook   │   │ BugBashQueue │                  │
│  │ Verifier       │   │ (sequential) │                  │
│  └───────┬────────┘   └──────┬───────┘                  │
│          │                   │                          │
│  ┌───────▼───────────────────▼──────────────────────┐   │
│  │               AgentService                       │   │
│  │  (generation counter · cancellation races)       │   │
│  └───────────────────┬──────────────────────────────┘   │
│                      │ AgentEvent stream                │
│              ┌───────▼────────┐                         │
│              │   EventBus     │──► WebSocket clients    │
│              │  (500-event    │    (React dashboard)    │
│              │   ring buffer) │                         │
│              └────────────────┘                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Agent Core                            │
│                                                         │
│  JiraPlanSynthesizer ──► TestPlanGenerator              │
│         │                      │                        │
│         │ (JiraContext)         │ (TestPlan)             │
│         ▼                      ▼                        │
│  AgentOrchestrator ◄───────────┘                        │
│         │                                               │
│  ┌──────▼──────────────────────────────────────┐        │
│  │  CopilotService (preflight / analysis /     │        │
│  │  executive summary / report persistence)    │        │
│  └─────────────────────────────────────────────┘        │
│         │                                               │
│  ┌──────▼──────────┐    ┌──────────────────────┐        │
│  │  SelectorHealer │    │  FailureExplainer     │        │
│  │  (5-strategy    │    │  (OpenAI gpt-4o-mini) │        │
│  │   healing)      │    └──────────────────────┘        │
│  └─────────────────┘                                    │
└──────────────────────┬──────────────────────────────────┘
                       │ Appium HTTP commands
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Appium Executor                            │
│                                                         │
│  AppiumLauncher ──► AppiumSession ──► FlowActions       │
│                          │                              │
│                   xcrun simctl                          │
│                  recordVideo (mp4)                      │
└──────────────────────┬──────────────────────────────────┘
                       │ XCUITest / WebDriverAgent
                       ▼
         ┌─────────────────────────────┐
         │  Toast Operator Production  │
         │  iOS Simulator              │
         │  (Unified Inventory module) │
         └──────────────┬──────────────┘
                        │ screenshots · video · pass/fail
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Evidence & Notification Layer              │
│                                                         │
│  JiraClient ──► attachFile · createBug · addComment     │
│  Slack Incoming Webhook ──► Block Kit summary           │
│  reports/ ──► executive-summary.json/.html              │
└─────────────────────────────────────────────────────────┘
```

---

## Subsystem Deep-Dive

### 1. Server & Orchestration Layer

**Purpose.** The central nervous system of ToastPilot. It exposes a REST and WebSocket API (Express/ws, default port 9477), receives external triggers (dashboard commands, GitHub PR-merge webhooks, bug-bash requests), and orchestrates the downstream AI agent by delegating to AgentService. It also manages build lifecycle tracking, knowledge file serving, artifact delivery, Jira/Slack integration, and real-time event fan-out to connected dashboard clients.

**Key Files**

| File | Responsibility |
|------|---------------|
| `server/index.ts` | Express HTTP + WebSocket entrypoint: wires all routes, instantiates subsystem singletons, implements HMAC-verified GitHub webhook, build state machine, and autonomous post-merge QA loop |
| `server/AgentService.ts` | Thin stateful wrapper around AgentOrchestrator: manages one active run at a time, handles cancellation races via a generation counter, bridges run events to EventBus |
| `server/EventBus.ts` | In-process pub/sub bus: broadcasts AgentEvent objects to all connected WebSocket clients, maintains a capped 500-event replay history for late-joining clients |
| `server/BugBashQueue.ts` | Sequential multi-ticket test runner: iterates Jira keys, synthesises each into a flow, delegates to AgentService, attaches evidence to Jira, posts an aggregate Block Kit summary to Slack |
| `knowledge/inventory-flows.json` | Static registry of 22 named test flows with id, name, aliases, module, entryTab, sessionPolicy, and steps |
| `knowledge/accessibility-registry.json` | Maps ToastUnifiedInventory to accessibility identifiers, per-flow element registries, and 5 self-healing strategies |

**Data Flow.**
External triggers arrive at `server/index.ts` routes. For single-run commands, the route optionally auto-resolves a Jira ticket key via JiraClient and JiraPlanSynthesizer to produce a synthesized command and JiraContext, then calls `agentService.start(command, jiraContext)`. AgentService increments its generation counter, cancels any in-flight run, constructs a fresh AgentOrchestrator, and awaits the run. The orchestrator publishes AgentEvent objects during execution via `(event) => bus.publish(event)`. EventBus deep-clones each event (JSON round-trip), appends it to a capped 500-entry ring buffer, and fans it out as serialized JSON to all open WebSocket clients at `/ws`. On run completion, callers read the returned AgentRun to extract pass/fail counts, screenshot list, and video path, then call JiraClient to attach evidence and POST a Block Kit payload to `SLACK_WEBHOOK_URL`.

**Design Decisions**

- The generation counter in AgentService (`runGeneration`) prevents stale completions from clobbering state when rapid back-to-back commands arrive; a superseded run throws `'Run superseded by a newer command'`.
- EventBus performs a deep-clone (`JSON.parse(JSON.stringify(...))`) on every published event to prevent the mutable AgentRun object from retroactively corrupting earlier history entries.
- EventBus caps history at 500 events and replays the last 100 to each newly connected WebSocket client.
- CORS is restricted to exactly `['http://localhost:5177', 'http://127.0.0.1:5177']`; the WebSocket server applies the same origin check and closes with code 1008 on violation.
- The GitHub webhook endpoint verifies `X-Hub-Signature-256` using HMAC-SHA256 + `timingSafeEqual`; raw body is captured by the `express.json` verify callback before parsing.
- Artifact path parameters (`:runId`, `:file`) are validated against strict regexes (UUID format and allowlisted extensions `mp4/png/jpg/jpeg`) before any filesystem access to prevent path traversal.
- The webhook only processes PRs merged into `main` and only acts on `SMB-*` ticket keys (searched in PR title, branch name, body in that priority order).
- If a bug bash session is running when a PR-merge webhook arrives, the QA run is deferred — not queued — and a Slack notification is sent requesting manual re-trigger.
- Build state is persisted in `.build-state.json` and reconciled on startup: if the stored PID is no longer running the state is corrected to `inProgress=false`.
- Screenshot attachment to Jira is capped at 10 files per run (`slice(0, 10)`).

---

### 2. Agent Core (Planning, Healing, AI)

**Purpose.** The autonomous QA orchestration engine. It translates a natural-language or Jira-driven test command into a sequenced TestPlan, drives that plan step-by-step against an iOS simulator via Appium, performs self-healing when selectors fail, and uses OpenAI to generate explanations, dynamic flows, and full feature automation artifacts. On completion it assembles an executive summary and persists a run report and screen recording.

**Key Files**

| File | Responsibility |
|------|---------------|
| `agent/core/AgentOrchestrator.ts` | Top-level run coordinator: owns AgentRun lifecycle, drives step-execution loop, triggers healing, screenshots, video recording, copilot preflight/failure-analysis/executive-summary, emits all AgentEvents |
| `agent/core/TestPlanGenerator.ts` | Converts a command string into a TestPlan via deterministic intent routing, alias matching, optional AI fallback; supports `and`-combined multi-flow plans and Jira AC augmentation |
| `agent/core/SelectorHealer.ts` | Self-healing XCUITest selector recovery: tries registry lookup, action-specific defaults, prefix pattern matching, fuzzy Levenshtein page-source scoring, and Swift repo scan |
| `agent/core/DynamicFlowGenerator.ts` | AI-driven on-demand flow creation: fetches a GitHub PR diff, sends it with Jira context to OpenAI to compose a step sequence, writes the resulting flow into `inventory-flows.json` |
| `agent/core/FailureExplainer.ts` | Delegates step-failure context to OpenAIClient.explainFailure and returns a plain-English explanation string |
| `agent/core/FeatureCodegen.ts` | Fully autonomous test artifact generation: given a Jira ticket and promoted locator IDs, calls OpenAI to generate FlowActions methods, a flows JSON entry, JiraPlanSynthesizer keywords, and AgentOrchestrator handler lines |
| `agent/core/OpenAIClient.ts` | Thin OpenAI wrapper (gpt-4o-mini default, overridable via `OPENAI_MODEL`) with graceful offline fallback for test plan generation, Jira synthesis, failure explanation, and dynamic flow generation |
| `agent/core/flowCompletion.ts` | Lookup table of user-facing success copy (heading, message, speech) keyed by flow ID |
| `agent/types.ts` | Canonical shared types: RunStatus, StepStatus, TestStep, TestPlan, AgentRun, HealingEvent, ScreenshotArtifact, LogEntry, JiraContext, BugBashTicketResult, AgentEvent discriminated union |
| `agent/cli.ts` | Minimal CLI entry point: reads argv as the command string, instantiates AgentOrchestrator with a console-printing event handler, exits with code 0/1 |
| `knowledge/inventory-flows.json` | Static flow registry (22 flows); DynamicFlowGenerator also writes temporary `dynamic-*` entries here at runtime |
| `knowledge/accessibility-registry.json` | Accessibility ID knowledge base: 7 screen entries for cycleCount, parallel structure for productCatalog, 5 ranked healing strategies |

**Data Flow.**
Command string (or Jira ticket) enters `AgentOrchestrator.runCommand`. CopilotService.preflight runs synchronously producing feature analysis and scenario recommendations (emitted as `copilot:feature-analysis` and `copilot:scenarios` events). TestPlanGenerator.generate resolves the command: (1) splits on `and` for multi-flow, (2) runs deterministic `matchFlowByIntent` → `resolveFlowByAliases` against `inventory-flows.json`, (3) falls back to OpenAIClient.generateTestPlan if no flow matches. The orchestrator enters the step-execution loop: for each step it dispatches to a FlowActions handler; if the handler returns a healed-selector result, SelectorHealer.toHealingEvent records a HealingEvent and step.status is set to `'healed'`; on step failure, CopilotService.analyzeFailure and FailureExplainer.explain produce a human-readable explanation. Screenshots are saved after every step; video is recorded via `xcrun simctl io recordVideo` started after `launchApp`. On run completion, CopilotService.buildExecutiveSummary assembles the report and CopilotService.persistReports writes it to `./reports`.

**Design Decisions**

- OpenAIClient checks for `OPENAI_API_KEY` at construction; every AI call returns null or an offline fallback string when the key is absent.
- After OpenAI returns a generated step list, a Set-based allowlist filter silently drops any action name not present in the hardcoded `ACTION_CATALOG_ARRAY`, and the entire result is rejected if fewer than 3 valid steps remain — preventing hallucinated actions from reaching the executor.
- TestPlanGenerator tries intent matching and alias scoring before ever calling OpenAI, so common flows execute with zero latency and zero API cost.
- A fixed `DEDUP_ONCE_ACTIONS` Set deduplicates setup actions (bootSimulator, launchApp, ensureLoggedIn, navigateToInventoryTab, verifyInventoryHome) when merging multi-flow or extends-based plans, so these run exactly once per session.
- `AGENT_DEMO_INJECT_FAILURE=true` combined with a 'cycle count'-containing command causes a synthetic exception at step index 2, exercising the full healing and failure-explanation pipeline without a real app bug. This variable defaults to `=== "true"` comparison and is off by default.
- FeatureCodegen idempotency: codegen markers (`FA_CODEGEN_START/END`, `ORC_CODEGEN_START/END`) allow repeated runs to replace rather than append the generated block in FlowActions.ts and AgentOrchestrator.ts.
- Video recording resilience: the orchestrator kills any stale `simctl io.*recordVideo` processes before spawning a new one, retries once on non-zero non-SIGINT exit, and polls up to 10 seconds (20 × 500 ms) for the MP4 file to appear.
- PR diff filtering in DynamicFlowGenerator keeps only lines touching `ToastUnifiedInventory` paths and truncates to 8,000 characters before sending to OpenAI.

---

### 3. Appium Executor (Real Device Automation)

**Purpose.** Drives the ToastOperator iOS app on a local simulator through Appium/XCUITest, executing multi-step QA flows. Owns process lifecycle management for the Appium server, WebDriverIO session creation and capability negotiation, all concrete UI interactions (tap, type, swipe, scroll, orientation, gestures), a selector self-healing path backed by SelectorHealer, and a code-generation pipeline that keeps UI locators synchronized with the live Swift source tree.

**Key Files**

| File | Responsibility |
|------|---------------|
| `agent/executor/AppiumLauncher.ts` | Manages Appium server process lifecycle: verifies installation, starts/stops a managed child process, polls for readiness via HTTP /status, exposes host/port constants |
| `agent/executor/AppiumSession.ts` | Wraps a WebDriverIO Browser instance with typed, resilient interaction primitives (tap with selector healing, type, swipe, scroll, orientation, alert handling) |
| `agent/executor/FlowActions.ts` | High-level test flow steps (inventory count, product catalog CRUD, invoice upload, login/logout, settings) built on AppiumSession, with inline locator map `L` that is partially auto-generated |
| `agent/executor/LocatorCodegen.ts` | Code-generation tool that greps Swift source for `.accessibilityIdentifier()` calls, writes `generated-locators.ts`, and auto-promotes new locator entries into `L` in FlowActions.ts |
| `agent/executor/RepoLocatorScanner.ts` | Runtime scanner that reads Swift sources and automation TS locator files to build a searchable in-memory index of accessibility identifiers, used as a fallback during self-healing |
| `agent/executor/loginFlow.ts` | Performs Toast Operator login (email + password via XPath locators), handles reCAPTCHA dismissal, xmark/no-thanks modals, and navigates to the Inventory tab post-login |
| `agent/executor/simulatorConfig.ts` | Resolves iOS simulator target (device name, platform version, UDID) from environment variables or live `xcrun simctl` output, with preference ordering over known device names |
| `agent/executor/generated-locators.ts` | Auto-generated read-only registry of all accessibility identifiers extracted from ToastUnifiedInventory Swift source, exported as `GL` grouped by module |

**Data Flow.**
Environment variables and `xcrun simctl` output → `simulatorConfig.ts` resolves device name/UDID/platform version → `AppiumSession.connect()` passes those as XCUITest capabilities to WebDriverIO `remote()`, after calling `AppiumLauncher.ensureAppiumRunning()`. WebDriverIO issues HTTP commands to the Appium server (localhost:4723 by default), which drives XCUITest on the simulator running `ToastOperator.app`. FlowActions methods call AppiumSession primitives using string selectors drawn from the inline `L` map. When `AppiumSession.tap()` fails on a selector, it calls `SelectorHealer.heal()` passing the failed selector and current page XML source; if healing produces a replacement, the tap is retried. Credentials flow from `.env` (TOAST_TEST_EMAIL, TOAST_TEST_PASSWORD) through `loginFlow.getTestCredentials()` into AppiumSession `type()` calls.

**Design Decisions**

- A module-level promise (`starting`) in AppiumLauncher prevents concurrent spawn races: if `ensureAppiumRunning` is called again while startup is in progress, the second call awaits the same promise.
- `AGENT_NO_RESET` env var defaults to true (`noReset=true`), meaning simulator state is preserved between test steps.
- `tap()` has a built-in demo failure injection path: when `opts.injectDemoFailure` is true and the selector contains `'StartCounting'`, it intentionally uses a wrong selector to trigger the healing path.
- Self-healing in `tap()` is always attempted on first failure: it gets page source, passes to `SelectorHealer.heal()`, retries with the healed selector, and returns `{ healed: true, healingReason }`.
- `tapWithFallback()` implements a three-level tap fallback: (1) `el.click()`, (2) `mobile: tap` with elementId, (3) `mobile: tap` with computed x/y coordinates.
- `setOrientation()` implements a three-level orientation fallback: `d.setOrientation()`, `mobile: rotateElement`, then osascript AppleScript against the Simulator app menu.
- `clearTextIfPossible()` tries three strategies (`clearValue()`, `mobile: clearText` with elementId, `setValue('')`) and an optional aggressive mode.
- LocatorCodegen uses a `PROMOTED_BLOCK_START/END` marker pair to surgically update only the auto-promoted section of FlowActions.ts on every codegen run, leaving hand-written entries untouched.
- Dynamic Swift IDs (containing `\(` interpolation) are converted by `makeSelector()` to `-ios predicate string:name BEGINSWITH prefix`; `makeDynamicSelectors()` also emits First/Second/Nth XPath positional variants.
- RepoLocatorScanner caches its scan result for the process lifetime and only rescans when `forceRefresh=true` is passed.
- Simulator device preference order is hardcoded as `[iPhone 17 Pro, iPhone 16 Pro, iPhone 15 Pro, iPhone 15]`; env vars `IOS_DEVICE_NAME` / `IOS_SIMULATOR_DEVICE` override the preference list.
- loginFlow reads credentials exclusively from `.env` (loaded via dotenv with `override:true`); missing credentials throw an explicit error rather than proceeding with empty strings.
- AppiumSession verifies the `TOAST_ENVIRONMENT` and `CFBundleIdentifier` plist fields of the installed `.app` at connect time, warning (but not failing) if the bundle is not Production / `com.toasttab.toastoperator`.

---

### 4. Leadership Copilot (Analysis and Reporting)

**Purpose.** Performs pre-run impact analysis of code changes, generates test scenarios and recommended agent commands, analyzes individual test failures (with optional LLM enrichment), and produces executive summary reports (JSON + HTML) after a test run. It bridges raw git/PR/Jira context into structured QA decisions and converts completed AgentRun results into human-readable leadership artifacts.

**Key Files**

| File | Responsibility |
|------|---------------|
| `copilot/CopilotService.ts` | Facade composing ChangeDetector, FailureAnalysisService, and ReportGenerator into four public methods: preflight, analyzeFailure, buildExecutiveSummary, and persistReports |
| `copilot/changeDetection/ChangeDetector.ts` | Runs git diff against ToastUnifiedInventory, maps changed files and PR/commit text to impacted areas via regex patterns, generates test scenarios, ranks flow IDs, computes a signal-based confidence score |
| `copilot/commandPreflight.ts` | Builds a full PreflightResult directly from a natural-language command string (bypassing git diff) by resolving flows via TestPlanGenerator and constructing Jira-AC-aware or generic scenarios |
| `copilot/confidence.ts` | Normalizes and clamps confidence scores: fraction-to-percent conversion, hard clamping to 58–99 range |
| `copilot/failure/FailureAnalysisService.ts` | Analyzes a failed TestStep by parsing the error string, correlating run logs and screenshots, applying rule-based offline heuristics; optionally enriches with OpenAI narrative explanation |
| `copilot/mergeDetection.ts` | Resolves a git diff range for post-merge CI contexts and lists changed ToastUnifiedInventory files to produce a MergeTestContext |
| `copilot/reporting/ReportGenerator.ts` | Builds ExecutiveSummaryReport from AgentRun plus optional PreflightResult and FailureAnalysis list; persists three files per run: JSON executive summary, HTML executive summary, and preflight JSON |
| `copilot/types.ts` | Canonical types: RiskLevel, ImpactedArea, GeneratedScenario, FeatureAnalysis, PreflightResult, FailureAnalysis, ExecutiveIssue, ExecutiveSummaryReport |

**Data Flow.**
Preflight path: CopilotService.preflight merges env vars with caller-supplied ChangeDetectionInput. If a command string is present, ChangeDetector delegates to `commandPreflight.buildCommandAlignedPreflight`, which calls TestPlanGenerator.resolveFlowsFromCommand and returns a PreflightResult immediately (no git diff). Without a command, ChangeDetector runs `spawnSync('git diff --name-only')` scoped to `ToastOperatorApp/ToastUnifiedInventory`, maps changed files against AREA_PATTERNS regexes, generates scenarios per area, deduplicates flow IDs, and computes a confidence score from concrete signals.

Failure analysis path: FailureAnalysisService.analyze applies regex heuristics on the error string to produce a possibleCause and baseline confidence (68–88). If `OPENAI_API_KEY` is present, calls `openai.explainFailure`; the returned narrative replaces possibleCause and adds +9 confidence.

Reporting path: ReportGenerator.buildExecutiveSummary aggregates AgentRun step statuses, PreflightResult, and FailureAnalysis list into ExecutiveSummaryReport. Confidence is derived from featureAnalysis.confidenceScore, reduced by 10× failed steps (capped at -28) or -18/-10 for failed/cancelled run status. ReportGenerator.persist writes `{runId}-executive-summary.json`, `{runId}-executive-summary.html`, and `{runId}-preflight.json`.

**Design Decisions**

- Command-first short-circuit: if a natural-language command is supplied, ChangeDetector bypasses git entirely. Git diff is only executed when no command is present.
- Offline-first failure analysis: FailureAnalysisService always produces a complete FailureAnalysis from deterministic regex heuristics before attempting any OpenAI call. The system never blocks on AI availability.
- Confidence score is bounded to 58–99 by `clampConfidence` (never 0 or 100) and is computed from concrete signals (file count, presence of prBody/jiraTicket/commitMessage/command, area count, scenario count, high-risk area count, OPENAI_API_KEY presence).
- Git operations are scoped exclusively to `ToastOperatorApp/ToastUnifiedInventory` — the diff path filter is hardcoded, preventing cross-module false positives.
- PR body is loaded from a file path (`COPILOT_PR_BODY_FILE`) rather than being passed as a raw env var, preventing oversized environment variables in CI.
- HTML report uses `escapeHtml` on all user-supplied strings, preventing XSS in the generated leadership report.
- Scenario generation distinguishes automatable vs. non-automatable flows using a static `AUTOMATABLE_FLOWS` Set; only automatable scenarios receive `stepActions` arrays and `testCommand` strings.

---

### 5. Jira Integration and Knowledge Base

**Purpose.** Connects ToastPilot's autonomous QA agent to Jira: fetches Jira tickets via REST API, translates ticket content into a concrete agent test command and a set of acceptance criteria, and writes back to Jira by creating Bug issues and posting generated test scenario comments.

**Key Files**

| File | Responsibility |
|------|---------------|
| `jira/JiraClient.ts` | HTTP wrapper around Jira REST API v3: fetches issues, creates Bug issues, attaches files, posts scenario comments |
| `jira/JiraPlanSynthesizer.ts` | Maps a JiraIssue to a runnable agent command and flowId using keyword scoring, with AI fallback via OpenAIClient |
| `knowledge/inventory-flows.json` | Static registry of all named test flows — id, human name, command aliases, module, entryTab, sessionPolicy, and ordered steps array |
| `knowledge/accessibility-registry.json` | Static map of iOS accessibility identifiers and XPath patterns per screen, plus a ranked list of 5 self-healing locator strategies |

**Data Flow.**
1. `JiraClient.fetchIssue(ticketKey)` validates the key format with `/^[A-Z][A-Z0-9_]+-\d+$/`, calls `GET /rest/api/3/issue/{key}?expand=renderedFields` with HTTP Basic auth. The raw Atlassian Document Format body is recursively flattened to plain text by `extractTextFromAdf`. Acceptance criteria are extracted first from an env-configurable custom field (`JIRA_AC_FIELD`, defaulting to `customfield_10500`), then by scanning for an "Acceptance Criteria" section header or Gherkin keywords (Given/When/Then) in the description text.

2. `JiraPlanSynthesizer.synthesize(issue)` builds a weighted text corpus from (summary ×2, acceptanceCriteria, description, labels, components), scores it against 20 hardcoded `FLOW_KEYWORDS` regex entries (score = matchCount × entryKeywordCount), and picks the highest scorer. If no regex fires, it calls `OpenAIClient.synthesizeCommandFromJira(issue)` and re-scores the AI-returned command. If that also yields nothing, it falls back to `"minimal-smoke"`.

3. Write-back paths: `JiraClient.createBug(payload)` POSTs a structured ADF Bug issue with sections for Failure Summary, Steps to Reproduce, and Agent Run Details, always prepending the label `"toastpilot-auto"`. `JiraClient.attachFile` uploads a binary via multipart FormData with the required `X-Atlassian-Token: no-check` header. `JiraClient.attachScenariosComment` POSTs an ADF comment listing generated test scenarios with category badges.

**Design Decisions**

- Authentication is HTTP Basic (email:apiToken base64-encoded) sent on every request; credentials are sourced exclusively from env vars, no hardcoded defaults.
- The `isConfigured` guard is checked at the top of every public method and throws a descriptive error rather than silently no-oping.
- Ticket key input is sanitized (trim + toUpperCase) and validated with a strict regex before any network call.
- The attachment endpoint requires the non-standard `X-Atlassian-Token: no-check` header (Atlassian XSRF bypass for attachment APIs); this is baked in explicitly.
- Story-point extraction probes four different custom field names to handle variance across Jira Cloud instances.
- Acceptance-criteria extraction has a three-tier fallback: dedicated custom field → section-header scan → Gherkin line filter.
- Flow selection in JiraPlanSynthesizer is deterministic-first: regex keyword scoring runs synchronously before any async AI call.
- More-specific flow IDs (e.g., `product-catalog-regression`) appear before their generic parents (e.g., `product-catalog`) in `FLOW_KEYWORDS`, so the first exact match wins correctly.

---

### 6. React Dashboard (Real-Time UI)

**Purpose.** The operator-facing real-time UI for ToastPilot. Renders live agent run state (status, plan steps, screenshots, logs, healing events, failure analysis, executive summary) received over a persistent WebSocket connection, and exposes controls to trigger test runs, cancel them, run a multi-ticket bug bash, file Jira bugs, attach run evidence to Jira, and send Slack QA reports.

**Key Files**

| File | Responsibility |
|------|---------------|
| `dashboard/src/main.tsx` | Vite entry point — mounts App inside React StrictMode onto `#root` |
| `dashboard/src/App.tsx` | Root UI component — composes all panels (Command Center, Live Feed, Failure Analysis, Bug Bash, Log Stream, Feature Analysis, Executive Summary) and owns all user-interaction handlers and local UI state |
| `dashboard/src/hooks/useAgentWebSocket.ts` | Manages WebSocket connection to backend, applies incoming AgentEvent messages to AgentRunState and CopilotDashboardState, handles Jira ticket resolution, command dispatch, polling fallback, bug bash orchestration, and video-ready polling |
| `dashboard/src/hooks/useGitStatus.ts` | Polls `/api/git/status` every 5 minutes for build staleness info, triggers Xcode builds via `/api/build`, polls `/api/build/status` every 3 s while a build is in progress |
| `dashboard/src/types.ts` | Canonical shared TypeScript types for all agent domain objects used across the UI |
| `dashboard/src/confidence.ts` | Single utility function normalizing a confidence value (0–1 fraction or 0–100 integer) to a rounded 0–100 integer |

**Data Flow.**
User input (textarea / voice / flow-browser click) → `sendCommand()` in `useAgentWebSocket` → optional Jira ticket resolution via `POST /api/jira/analyze` → optimistic local state set to `"planning"` → `POST /api/commands` → HTTP polling fallback starts (`GET /api/runs/current` every 600 ms) AND `GET /api/copilot/analyze` fires in parallel for pre-flight analysis. Backend pushes AgentEvent JSON frames over WebSocket → `ws.onmessage` → `applyEvent()` dispatches by event type → state updates applied incrementally (logs capped at 200 entries, copilot reasoning capped at 25 lines, run-ID guard drops stale events from prior runs). Screenshots arriving as `screenshot` events are appended to `AgentRunState.screenshots`; filmstrip thumbnails allow scrubbing; base64Preview data is decoded client-side for display and Save-as-PNG download.

**Design Decisions**

- WebSocket reconnection uses exponential back-off: `delay = min(1000 * 2^attempts, 30000 ms)`. A `'cancelled'` flag prevents reconnect attempts after the component unmounts.
- A polling fallback (`GET /api/runs/current` every 600 ms) is layered on top of WebSocket events to recover missed state. Polling stops immediately on `run:started` or `run:finished` events received via WebSocket.
- Stale-event guard: every non-`run:started` event is dropped if its `runId` does not match `activeRunIdRef.current`, preventing old run frames from corrupting a new run's state.
- Jira ticket auto-detection: `sendCommand()` applies `/\b([A-Z][A-Z0-9_]+-\d+)\b/` to the raw command string; if found, calls `/api/jira/analyze` first and substitutes the resolved flow command before dispatching.
- Log entries are bounded to the last 200 items and copilot reasoning to the last 25 items to prevent unbounded memory growth.
- Confetti and synthesized audio (Web Audio API: sawtooth party horn, triangle fanfare, sine chime cascade) fire exactly once per run ID on a clean pass. The run ID is tracked in `announcedRunIdRef` to prevent double-fire under StrictMode.
- The flow browser (`FLOW_MENU`) is a fully static client-side data structure in App.tsx covering 5 modules and 20 named flows — it is not fetched from the backend.
- Voice input uses the Web Speech API; transcript is piped directly to `sendCommand()`. Only Chrome is supported; other browsers receive an `alert()`.

---

## Data Flow — Full Request End-to-End

The following traces a Jira ticket command through the entire system to Slack notification.

```
1. USER INPUT
   Dashboard textarea: "SMB-4321"
   ↓
   sendCommand() detects /\b([A-Z][A-Z0-9_]+-\d+)\b/ in command string

2. JIRA RESOLUTION
   POST /api/jira/analyze  { ticketKey: "SMB-4321" }
   ↓
   server/index.ts → JiraClient.fetchIssue("SMB-4321")
     validates key with /^[A-Z][A-Z0-9_]+-\d+$/i
     GET /rest/api/3/issue/SMB-4321?expand=renderedFields  (HTTP Basic auth)
     extractTextFromAdf on ADF body
     three-tier AC extraction: customfield_10500 → section-header → Gherkin
   ↓
   JiraPlanSynthesizer.synthesize(issue)
     builds weighted corpus (summary×2, AC, description, labels, components)
     scores against 20 FLOW_KEYWORDS regex entries
     if no match → OpenAIClient.synthesizeCommandFromJira(issue) → re-score
     resolves to e.g. flowId="cycle-count", command="run cycle count tests"
   ↓
   buildJiraContext(issue, synthesis) → JiraContext { ticketKey, flowId,
     acceptanceCriteria[], summary, priority, storyPoints }
   ↓
   Response to dashboard: { command, flowId, rationale, jiraContext, ... }

3. COMMAND DISPATCH
   Dashboard substitutes resolved command and dispatches:
   POST /api/commands  { command: "run cycle count tests", jiraContext }
   ↓
   server/index.ts route → agentService.start(command, jiraContext)
   AgentService increments runGeneration, cancels any in-flight run,
   constructs fresh AgentOrchestrator

4. PREFLIGHT ANALYSIS
   AgentOrchestrator.runCommand → CopilotService.preflight
     command present → buildCommandAlignedPreflight (no git diff)
     TestPlanGenerator.resolveFlowsFromCommand matches "cycle count"
       against inventory-flows.json aliases
     Generates positive/negative/edge scenarios from JiraContext AC lines
   Emits: copilot:feature-analysis, copilot:scenarios
   → EventBus.publish → WebSocket clients (dashboard updates panels)

5. PLAN GENERATION
   TestPlanGenerator.generate("run cycle count tests", jiraContext)
     deterministic alias match → flowId "cycle-count"
     expandedStepsForFlows → TestPlan with TestStep[]
     DEDUP_ONCE_ACTIONS deduplicates setup steps
   Emits: plan:generated

6. STEP EXECUTION LOOP (per step)
   AgentOrchestrator dispatches step.action → FlowActions method
     FlowActions.tap(L['StartCountingButton'])
     AppiumSession.tap() → WebDriverIO HTTP → Appium → XCUITest → Simulator
   ↓
   On selector failure:
     AppiumSession gets page XML source
     SelectorHealer.heal(selector, pageXml, { stepId, action })
       Strategy 1: registry knownIds exact lookup
       Strategy 2: action-specific defaults
       Strategy 3: prefix pattern matching on dynamic IDs
       Strategy 4: fuzzy Levenshtein scoring against page XML
       Strategy 5: RepoLocatorScanner Swift repo scan
     tap() retried with healed selector
     Returns { healed: true, usedSelector, healingReason }
   ↓
   step.status = 'healed' | 'passed' | 'failed'
   Emits: step:started, step:finished, (step:healing if healed)
   Screenshots saved after each step
   → EventBus → dashboard filmstrip

7. FAILURE PATH (if step fails)
   CopilotService.analyzeFailure(run, step, errorMsg, pageSource)
     FailureAnalysisService.analyze
       regex heuristics → possibleCause, baseline confidence 68–88
       if OPENAI_API_KEY present:
         OpenAIClient.explainFailure({ command, step, error, pageSourceSnippet })
         narrative replaces possibleCause, +9 confidence
   FailureExplainer.explain → emits failure:explained
   Emits: failure:analysis
   → EventBus → dashboard Failure Analysis panel

8. RUN COMPLETION
   xcrun simctl io <udid> recordVideo stopped
   Orchestrator polls up to 10 s (20 × 500 ms) for MP4 file to appear
   CopilotService.buildExecutiveSummary(run, preflight, failureAnalyses)
     Aggregates step statuses, confidence (base - 10×failures, capped at -28)
   CopilotService.persistReports writes to ./reports/:
     {runId}-executive-summary.json
     {runId}-executive-summary.html
     {runId}-preflight.json
   Emits: copilot:executive-summary, run:finished

9. EVIDENCE ATTACHMENT (runPostMergeQA or BugBashQueue.runTicket)
   JiraClient.attachFile(issueKey, screenshotPath, name, mime)
     POST /rest/api/3/issue/{key}/attachments  (multipart, X-Atlassian-Token: no-check)
     capped at 10 screenshots (slice(0, 10))
     each wrapped in per-item try/catch — partial failures do not abort
   JiraClient.attachFile(issueKey, videoPath, "recording.mp4", "video/mp4")
   JiraClient.attachScenariosComment(issueKey, scenarios[])

10. SLACK NOTIFICATION
    fetch POST to SLACK_WEBHOOK_URL
    Block Kit payload with:
      flow name, pass/fail/total counts, confidence score,
      risk level, recommendation, Jira ticket link,
      artifact download links (video, screenshots)
    Dashboard: POST /api/slack/report (manual trigger)
```

---

## The Autonomous PR-Merge Pipeline

When a pull request is merged, GitHub delivers a `pull_request` webhook event to `POST /api/webhook/pr-merged` in `server/index.ts`. The pipeline proceeds through six verified steps:

**Step 1 — HMAC Signature Verification.**
Before any JSON parsing, `express.json`'s `verify` callback captures the raw request body bytes. `verifyGitHubSignature` computes `HMAC-SHA256(GITHUB_WEBHOOK_SECRET, rawBody)` and compares it to the `X-Hub-Signature-256` header using Node's `crypto.timingSafeEqual` on the raw digest bytes — preventing timing-oracle attacks. When `GITHUB_WEBHOOK_SECRET` is not set the check passes (documented dev-mode behaviour). Requests that fail verification receive a 401 response immediately.

**Step 2 — Merge and Branch Gating.**
The handler checks `payload.action === 'closed' && payload.pull_request.merged === true` and `payload.pull_request.base.ref === 'main'`. PRs not merged into `main` are silently ignored.

**Step 3 — SMB-* Ticket Extraction.**
`extractSmbTicket` searches for a Jira key matching `/SMB-\d+/i` in the PR title first, then the branch name, then the PR body. Only `SMB-*` prefixed tickets trigger autonomous QA. If no SMB ticket is found the webhook returns 200 with no action.

**Step 4 — Bug Bash Conflict Check.**
If a bug bash session is currently running (`bugBashQueue.isRunning()`), the autonomous run is deferred — not queued. A Slack notification is posted to `SLACK_WEBHOOK_URL` requesting a manual re-trigger. This prevents interleaving of automated and manual-batch test sessions.

**Step 5 — Flow Synthesis and Dynamic Generation.**
`runPostMergeQA` calls `JiraClient.fetchIssue` and `JiraPlanSynthesizer.synthesize` to produce a flowId. If the resolved flowId is `'minimal-smoke'` (weak match), `DynamicFlowGenerator.generate({ prNumber, prTitle, jiraContext })` is attempted: it fetches the GitHub PR diff (filtered to `ToastUnifiedInventory` paths, truncated to 8,000 characters), sends it to OpenAI's action-catalog-constrained prompt, and writes a `dynamic-<ticketKey>-<uuid>` flow entry into `inventory-flows.json`. Hard-untestable flows (`not-testable`, `manual-only`, `infrastructure`, `backend-only`, or components matching `/backend|infra|ios.build/`) skip dynamic generation entirely and post a manual-testing Slack notification.

**Step 6 — Agent Execution and Evidence Delivery.**
`agentService.start(command, jiraContext)` runs the full test pipeline. On completion, `runPostMergeQA` reads the returned AgentRun, attaches up to 10 screenshots and the screen recording to the Jira ticket (each in an individual try/catch so partial failures do not abort delivery), posts a scenario comment, and sends a Block Kit Slack summary with pass/fail counts, confidence score, risk level, and artifact links.

---

## Sprint Bug Bash

The `BugBashQueue` (in `server/BugBashQueue.ts`) provides a single-invocation sequential runner for a list of Jira ticket keys. Its design guarantees clean state isolation between tickets, safe cancellation, and a consolidated Slack summary regardless of partial failures.

**Sequential Execution.**
`BugBashQueue.start(tickets: string[])` iterates the ticket array in order. For each ticket, `runTicket(ticketKey)` calls `JiraClient.fetchIssue` and `JiraPlanSynthesizer.synthesize` to resolve a command, then calls `agentService.start(command, jiraContext)` and awaits the AgentRun. No two tickets run concurrently; the next ticket starts only after the current AgentRun resolves.

**Evidence Attachment.**
After each ticket's run, `runTicket` calls `JiraClient.attachFile` for each screenshot (capped at 10, each in an individual try/catch), `JiraClient.attachFile` for the video, and `JiraClient.attachScenariosComment`. Partial attachment failures are logged but do not abort the remaining tickets. A `bugbash:ticket:finished` event is emitted through EventBus after each ticket.

**Aggregate Slack Summary.**
After all tickets have run, `BugBashQueue.postAggregateSlack()` posts a single Block Kit message to `SLACK_WEBHOOK_URL` summarizing every ticket's outcome (pass/fail counts, flowId, Jira link) in a consolidated view.

**Cancellation and try-finally Safety.**
The queue checks a `cancelled` flag at the top of each ticket iteration. `BugBashQueue.cancel()` sets `cancelled = true` and calls `agentService.cancel()` to halt the in-flight run. The main `start()` body is wrapped in try/finally: even if an unhandled exception occurs mid-batch or cancellation is requested, `bugbash:finished` (or `bugbash:cancelled`) is always emitted through EventBus and the `isRunning()` flag is always cleared. This ensures the server never gets stuck believing a bug bash is active when it is not.

---

## Self-Healing Strategy

ToastPilot has 113 self-healing touchpoints across the executor and agent core. When a selector fails, the system applies the following strategies in order:

**Strategy 1 — Hardcoded Demo/Legacy Overrides.**
SelectorHealer maintains a small map of known-broken legacy IDs and their verified replacements. These are applied first as exact-match substitutions, with zero I/O cost.

**Strategy 2 — Registry Exact Lookup (accessibility-id).**
`accessibility-registry.json` lists known XCUITest accessibility identifiers per screen for both cycleCount and productCatalog flows. SelectorHealer builds a `knownIds` Set from this file at module load time and performs an O(1) lookup against the failed selector.

**Strategy 3 — Action-Specific Defaults.**
A per-action fallback table maps action names (e.g., `openProductCatalog`, `startCycleCount`) to their canonical selector values. When the step's action name matches, this is tried before any dynamic or fuzzy approach.

**Strategy 4 — Prefix Pattern Matching for Dynamic IDs.**
Swift views that use string interpolation (e.g., `"productRow_\(id)"`) produce non-static accessibility identifiers. `makeSelector()` converts these patterns to `-ios predicate string:name BEGINSWITH prefix` queries. `makeDynamicSelectors()` additionally emits First/Second/Nth XPath positional variants for cases where predicate matching is insufficient.

**Strategy 5 — Fuzzy Levenshtein Scoring Against Page Source.**
If all static strategies fail, SelectorHealer retrieves the live page XML from AppiumSession and scores all accessibility IDs in the XML against the failed selector using Levenshtein edit distance. The highest-scoring candidate above a minimum threshold is used as the replacement selector.

**Strategy 6 — Swift Repo Scan (RepoLocatorScanner).**
As a final fallback, `RepoLocatorScanner.resolveLocator(id)` searches the live Swift source tree for exact `.accessibilityIdentifier()` assignments matching the failed ID, and `findLocators(query, n)` performs a fuzzy multi-result search. Results are cached for the process lifetime; `forceRefresh=true` triggers a rescan.

**tapWithFallback Three-Level Retry.**
Independent of selector healing, `AppiumSession.tapWithFallback()` provides a three-level fallback for tap mechanics: (1) `el.click()`, (2) `mobile: tap` with elementId, (3) `mobile: tap` with computed x/y coordinates. This insulates tests from partial XCUITest tap failures that are unrelated to selector correctness.

**LocatorCodegen Promotion Pipeline.**
When a self-healing event resolves a previously unknown selector, `LocatorCodegen.promoteToFlowActions()` can write the new locator into the auto-promoted block of `FlowActions.ts` (bounded by `PROMOTED_BLOCK_START/END` markers), preventing the same healing event from being needed on subsequent runs.

---

## Security Model

| Constraint | Enforcement |
|------------|-------------|
| Runs against real Toast Operator Production simulator | `AppiumSession.connect()` reads `TOAST_OPERATOR_APP_PATH` (or a default relative path); no mock or stub UI layer exists in the codebase |
| Credentials never in source | `TOAST_TEST_EMAIL` and `TOAST_TEST_PASSWORD` read exclusively from `.env` (dotenv with `override:true`); `.env` is gitignored; `loginFlow.getTestCredentials()` throws an explicit error rather than proceeding with empty strings |
| `AGENT_DEMO_INJECT_FAILURE` defaults OFF | Read in `AgentOrchestrator` with a strict `=== "true"` string comparison; any value other than the exact string `"true"` leaves the path disabled |
| CORS restricted to localhost:5177 only | `server/index.ts` passes `origin: ['http://localhost:5177', 'http://127.0.0.1:5177']` to the Express CORS middleware; the WebSocket server performs the same origin check and closes with code 1008 on violation |
| Only SMB-* Jira tickets trigger autonomous QA | `extractSmbTicket` in `server/index.ts` requires a match against `/SMB-\d+/i`; non-matching webhooks return 200 with no action |
| GitHub webhook verified with HMAC-SHA256 via timingSafeEqual | `verifyGitHubSignature` captures raw body bytes in the `express.json` verify callback, computes `HMAC-SHA256(GITHUB_WEBHOOK_SECRET, rawBody)`, and compares to `X-Hub-Signature-256` using `crypto.timingSafeEqual` on raw digest bytes — preventing timing-oracle attacks |
| Artifact path traversal prevention | `:runId` validated against UUID regex; `:file` validated against an allowlist of extensions (`mp4`, `png`, `jpg`, `jpeg`) before any filesystem access |
| Jira key injection prevention | All ticket keys are trim + toUpperCase normalized and validated against `/^[A-Z][A-Z0-9_]+-\d+$/i` before any REST call |
| No OpenAI key — no AI paths, no crash | `OpenAIClient` checks `OPENAI_API_KEY` at construction; every AI call returns null or an offline fallback string when absent |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js, TypeScript (tsx) |
| HTTP Server | Express.js |
| WebSocket | ws |
| iOS Automation | Appium 2.x, WebDriverIO, XCUITest / WebDriverAgent |
| Simulator Control | xcrun simctl (Apple SDK) |
| AI / LLM | OpenAI API (gpt-4o-mini default, gpt-4o for FeatureCodegen) |
| Dashboard | React 18, Vite, TypeScript |
| Jira Integration | Jira REST API v3 (HTTP Basic auth) |
| Slack Integration | Slack Incoming Webhooks (Block Kit) |
| GitHub Integration | GitHub PR Webhook (HMAC-SHA256 verified) |
| Knowledge Base | Static JSON files (inventory-flows.json, accessibility-registry.json) |
| String Similarity | Levenshtein edit distance (selector healing) |
| Build Tooling | tsx, Vite |
| Environment | dotenv |
| Confidence Reporting | Custom signal-based scoring, clamped 58–99 |

---

## Project Stats

| Metric | Value |
|--------|-------|
| TypeScript/TSX source files | 48 |
| Total lines of code | 14,320 |
| Ready-to-run test flows | 22 |
| Self-healing touchpoints | 113 |
| iOS modules covered | 3 (Cycle Count, Product Catalog, Invoice Scanning) |
| Server default port | 9477 |
| Dashboard default port | 5177 |
| EventBus history ring buffer | 500 events (100 replayed on reconnect) |
| OpenAI model (default) | gpt-4o-mini (OpenAIClient), gpt-4o (FeatureCodegen) |
| Max screenshots attached per Jira ticket | 10 |
| Video flush poll | 20 × 500 ms (10 seconds max) |
| Log entries cap (dashboard) | 200 |
| Confidence score range | 58–99 (never 0 or 100) |