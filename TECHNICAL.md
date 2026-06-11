# ToastPilot — Technical Reference

A precise, code-grounded reference for engineers. For the narrative design see [DESIGN.md](DESIGN.md), for the feature overview see the [README](README.md), and for the hackathon pitch see [HACKATHON.md](HACKATHON.md).

---

## At a Glance

| | |
|---|---|
| **Language** | TypeScript (run with `tsx`, no build step needed for dev) |
| **Source size** | 14,320 lines across 48 files |
| **Server** | Node.js · Express · `ws` WebSocket · default port `9477` |
| **Dashboard** | React 18 · Vite · default port `5177` |
| **Automation** | Appium 3 · `appium-xcuitest-driver` 10.x · WebDriverIO 9 · port `4723` |
| **AI** | OpenAI (`gpt-4o-mini` default, configurable) — degrades gracefully when absent |
| **Test flows** | 22 flows across 3 iOS modules |
| **Action methods** | 102-method Appium engine (`FlowActions.ts`) |
| **Self-healing** | 113 healing touchpoints |
| **Integrations** | Jira REST v3 · Slack Block Kit · GitHub PR webhook (HMAC-SHA256) |

---

## Repository Layout

```
ai-qa-agent/
├── agent/
│   ├── cli.ts                       # standalone CLI entry
│   ├── types.ts                     # shared agent types + AgentEvent contract
│   ├── core/
│   │   ├── AgentOrchestrator.ts     # the step-execution loop
│   │   ├── TestPlanGenerator.ts     # command/Jira → structured TestPlan
│   │   ├── DynamicFlowGenerator.ts  # PR diff → AI-authored flow
│   │   ├── SelectorHealer.ts        # 5-strategy selector recovery
│   │   ├── FailureExplainer.ts      # plain-English failure narrative
│   │   ├── FeatureCodegen.ts        # AI generates new test code
│   │   ├── OpenAIClient.ts          # thin OpenAI wrapper + offline fallback
│   │   └── flowCompletion.ts
│   └── executor/
│       ├── AppiumLauncher.ts        # spawn/reuse the Appium server
│       ├── AppiumSession.ts         # resilient WebDriverIO primitives
│       ├── FlowActions.ts           # 102 action methods (the engine)
│       ├── LocatorCodegen.ts        # promote healed selectors into source
│       ├── RepoLocatorScanner.ts    # scan Swift source for accessibility IDs
│       ├── loginFlow.ts             # credential-driven login
│       └── simulatorConfig.ts       # device/UDID/version resolution
├── copilot/
│   ├── CopilotService.ts            # preflight · analysis · summary facade
│   ├── changeDetection/ChangeDetector.ts
│   ├── failure/FailureAnalysisService.ts
│   ├── reporting/ReportGenerator.ts
│   ├── commandPreflight.ts · confidence.ts · mergeDetection.ts · types.ts
├── jira/
│   ├── JiraClient.ts                # REST v3: fetch, attach, comment, create bug
│   └── JiraPlanSynthesizer.ts       # ticket → command + acceptance criteria
├── server/
│   ├── index.ts                     # all HTTP routes + webhook + build state
│   ├── AgentService.ts              # one-run lifecycle, cancellation-safe
│   ├── EventBus.ts                  # pub/sub, 500-event replay ring buffer
│   └── BugBashQueue.ts              # sequential multi-ticket runner
├── dashboard/
│   └── src/
│       ├── App.tsx                  # all panels + handlers
│       ├── hooks/useAgentWebSocket.ts  # WS state machine + polling fallback
│       ├── hooks/useGitStatus.ts    # build freshness + one-tap rebuild
│       └── types.ts · confidence.ts · main.tsx
├── knowledge/
│   ├── inventory-flows.json         # the 22 flow definitions
│   └── accessibility-registry.json  # known IDs + healing strategies
└── scripts/
    ├── demo.ts                      # `npm run agent` — boots everything
    ├── build-operator-app.ts        # xcodebuild + scheme/bundle verify
    ├── boot-simulator.ts · setup-appium.ts · generate-locators.ts · …
```

---

## How to Run

```bash
./run-agent.sh
```

This installs dependencies on first run, then runs `npm run agent` → `scripts/demo.ts`, which:
1. Boots the iOS Simulator (best effort)
2. Starts Appium on `:4723` if it isn't already running
3. Starts the agent server (`:9477`) and the dashboard (`:5177`)
4. Opens the dashboard in your default browser

| Command | What it does |
|---|---|
| `./run-agent.sh` | Primary entry — installs deps, boots the full stack |
| `npm run agent` / `npm run demo` | Same as above, without the dep check |
| `npm run dev` | Boots Appium + server + dashboard via `concurrently` |
| `npm run app:build` | Force-rebuild the Toast Operator app (`xcodebuild`) |
| `npm run locators:generate` | Scan Swift source → generate new selectors |
| `npm run feature:generate` | Generate test code for a new feature |
| `npm run build` | Production build (dashboard + `tsc`) |

---

## HTTP API

All routes are served by `server/index.ts`. CORS is locked to `http://localhost:5177` / `http://127.0.0.1:5177`.

### Run control
| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/commands` | Start a run from a command or Jira context (`409` if a run is active) |
| `POST` | `/api/commands/cancel` | Cancel the active run |
| `POST` | `/api/cancel` | Alias for cancel |
| `GET` | `/api/runs/current` | Current run state (used by the polling fallback) |
| `GET` | `/api/events` | Recent events from the EventBus ring buffer |

### Copilot & analysis
| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/copilot/analyze` | Preflight: feature analysis, scenarios, recommended command |
| `GET` | `/api/copilot/analyze` | Git-diff-based change analysis |

### Jira
| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/jira/status` | Whether Jira is configured |
| `POST` | `/api/jira/analyze` | Synthesize a test plan from a ticket key |
| `POST` | `/api/jira/attach` | Attach screenshots / video / scenarios to a ticket |
| `POST` | `/api/jira/create-bug` | File a linked bug ticket |

### Bug Bash
| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/bug-bash/start` | Start a sequential multi-ticket session (`202`, runs async) |
| `POST` | `/api/bug-bash/cancel` | Abort after the current ticket |
| `GET` | `/api/bug-bash/status` | `{ running, sessionId }` |

### Build & git
| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/git/status` | Commits-behind-main, last-built SHA, freshness |
| `POST` | `/api/build` | Spawn a detached `xcodebuild` (`409` if a run/build is active) |
| `GET` | `/api/build/status` | Live build progress (tail of the build log) |

### Evidence, reports & knowledge
| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/artifacts/:runId/:file` | Stream a screenshot/video (validated `runId` + extension allowlist) |
| `GET` | `/api/artifacts/:runId/screenshot-list` | Gallery of a run's screenshots |
| `GET` | `/api/reports/:runId/executive-summary.json` | Executive summary (JSON) |
| `GET` | `/api/reports/:runId/executive-summary.html` | Executive summary (HTML) |
| `GET` | `/api/knowledge/flows` | The 22 flow definitions |
| `GET` | `/api/knowledge/accessibility` | Accessibility registry |
| `POST` | `/api/slack/report` | Send a Block Kit QA report to Slack |
| `GET` | `/api/health` | Health + which integrations are configured |

### Webhook
| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/webhook/pr-merged` | GitHub PR-merge trigger — HMAC-SHA256 verified, SMB-* only |

---

## Real-Time Event Contract

The server pushes `AgentEvent` JSON frames over the WebSocket at `/ws`. The dashboard's `useAgentWebSocket` hook applies them to state; a `GET /api/runs/current` poll (600 ms) is layered on as a fallback.

| Event | Meaning |
|---|---|
| `history` | Replay of recent events on (re)connect (last 100 of a 500-ring) |
| `run:started` | A new run began (carries id, command, Jira context) |
| `run:status` | Run status changed |
| `plan:generated` | Test plan with ordered steps is ready |
| `step:started` | A step began executing |
| `step:finished` | A step resolved (passed / failed / healed) |
| `step:healing` | A selector was healed mid-run (original → healed → strategy) |
| `log` | A log line (capped at last 200 on the client) |
| `screenshot` | A per-step screenshot artifact |
| `failure:explained` | Plain-English failure narrative |
| `failure:analysis` | Structured failure analysis |
| `copilot:feature-analysis` | Impact + risk preflight |
| `copilot:scenarios` | Generated scenarios + recommended command |
| `copilot:reasoning` | Strategic Insight Trace line (capped at last 25) |
| `copilot:executive-summary` | Final leadership summary + confidence |
| `run:finished` | Run complete (status, failure, video path) |
| `bugbash:started` | Bug Bash session began (ticket list) |
| `bugbash:ticket:started` | A ticket started (index / total) |
| `bugbash:ticket:finished` | A ticket resolved (passed, runId) |
| `bugbash:finished` | Whole session done (per-ticket results) |
| `bugbash:cancelled` | Session aborted |

---

## Test Flows (22)

All defined in `knowledge/inventory-flows.json`, runnable by `id`, by name alias, by Jira ticket, by voice/text, or auto-selected on PR merge.

**Authentication & smoke**
`login-only` · `logout-only` · `minimal-smoke`

**Cycle Count**
`cycle-count` · `cycle-count-smoke` (full regression) · `cycle-count-from-template` · `add-new-item` · `edit-item` · `add-item-location` · `post-submission-ui`

**Product Catalog**
`product-catalog` · `product-catalog-regression` · `product-catalog-add-edit-delete` · `product-catalog-details` · `product-catalog-filters` · `pc-filter-refresh`

**Invoice Scanning**
`upload-invoice` · `invoice-scanning` · `invoice-scanning-regression` · `invoice-landscape-popup`

**Full app**
`full-smoke` · `full-regression` (50+ steps, all modules)

---

## Self-Healing Strategy

`SelectorHealer` recovers from selector drift at runtime. Strategies are applied in order — 113 healing touchpoints across the executor and core:

1. **Registry exact lookup** — known accessibility IDs from `accessibility-registry.json` (O(1))
2. **Action-specific defaults** — canonical selector per action name
3. **Prefix / dynamic-ID matching** — `-ios predicate string:name BEGINSWITH` for interpolated Swift IDs, plus positional XPath variants
4. **Fuzzy page-source scan** — Levenshtein scoring against the live page XML
5. **Swift repo scan** — `RepoLocatorScanner` finds `.accessibilityIdentifier()` assignments in source

Independently, `AppiumSession.tapWithFallback()` provides a three-level tap fallback (`el.click()` → `mobile: tap` by element → `mobile: tap` by coordinates). Healed selectors can be promoted back into `FlowActions.ts` by `LocatorCodegen` so the same heal isn't needed twice.

---

## Configuration (`.env`)

### Core
| Variable | Default | Purpose |
|---|---|---|
| `TOAST_TEST_EMAIL` / `TOAST_TEST_PASSWORD` | — | QA login (only here, never in source) |
| `XCODE_SCHEME` | `ToastOperator Production` | Build scheme |
| `AGENT_NO_RESET` | `true` | Reuse login session across steps |
| `TOAST_OPERATOR_APP_PATH` | `../automation/app/ToastOperator.app` | Installed app bundle |
| `AGENT_SERVER_PORT` | `9477` | Server port |
| `AGENT_DASHBOARD_PORT` | `5177` | Dashboard port |

### AI
| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Enables AI features (optional — graceful fallback) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model override |

### Simulator
| Variable | Purpose |
|---|---|
| `IOS_DEVICE_NAME` / `IOS_SIMULATOR_DEVICE` | Override device (default preference: iPhone 17 Pro → 16 Pro → 15 Pro → 15) |
| `IOS_PLATFORM_VERSION` / `IOS_SIMULATOR_VERSION` | Override iOS version |
| `IOS_SIMULATOR_UDID` | Pin a specific simulator |
| `APPIUM_PORT` / `APPIUM_HOST` / `APPIUM_AUTO_START` | Appium connection |

### Integrations (optional)
| Variable | Purpose |
|---|---|
| `JIRA_BASE_URL` / `JIRA_USER_EMAIL` / `JIRA_API_TOKEN` | Jira REST v3 auth |
| `JIRA_PROJECT_KEY` / `JIRA_AC_FIELD` | Bug project + acceptance-criteria field |
| `SLACK_WEBHOOK_URL` / `SLACK_REPORTER_NAME` | Slack notifications |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for the PR-merge webhook |
| `GITHUB_TOKEN` / `GITHUB_REPO` / `GITHUB_API_HOST` | PR diff fetch for dynamic flows |
| `AGENT_PUBLIC_URL` | Base URL for Slack evidence links (when not localhost) |

### Build / Copilot (advanced)
`AGENT_FORCE_REBUILD` · `AGENT_USE_BUILD_MODULE` · `IOS_REPO_PATH` · `IOS_SWIFT_SOURCE_ROOT` · `UNIFIED_INVENTORY_ROOT` · `COPILOT_GIT_BASE` · `COPILOT_PR_BODY_FILE` · `COPILOT_JIRA_TICKET`

> ⚠️ `AGENT_DEMO_INJECT_FAILURE` is a demo-only flag, checked with strict `=== "true"` so it defaults **off**.

---

## Security Model

| Control | Enforcement |
|---|---|
| Real app, no mocks | `AppiumSession` verifies the installed `.app` `TOAST_ENVIRONMENT` + `CFBundleIdentifier` at connect |
| Secrets never in source | Credentials read only from `.env` (gitignored); login throws on missing creds |
| Webhook authenticity | `HMAC-SHA256(GITHUB_WEBHOOK_SECRET, rawBody)` compared with `timingSafeEqual` on raw digest bytes |
| Scoped autonomy | Only `SMB-*` tickets trigger autonomous QA; non-`main` merges ignored |
| CORS | Locked to the local dashboard origin; WebSocket performs the same origin check |
| Path-traversal safety | `runId` validated against a UUID regex; artifact filenames against an extension allowlist |
| Jira key injection | Ticket keys validated against `^[A-Z][A-Z0-9_]+-\d+$` before any REST call |
| Concurrency safety | One agent run at a time; webhook defers if a Bug Bash is running; build refused during a run |

---

## Tech Stack

Appium 3 + XCUITest · WebDriverIO 9 · React 18 + Vite · Node.js + Express + `ws` · OpenAI GPT-4o-mini · Jira REST API v3 · Slack Block Kit · GitHub webhooks · `xcodebuild` · `xcrun simctl` (incl. `recordVideo`) · TypeScript throughout.
