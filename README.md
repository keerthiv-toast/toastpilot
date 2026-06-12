# ToastPilot — Fully Autonomous AI QA Agent for ToastUnifiedInventory

> **"Zero human. Zero mock. Zero compromise."**
> ToastPilot drives the real **Toast Operator Production** app on a live iOS Simulator — no fake screens, no stubs, no scripted shortcuts. Every test runs against production code, production accessibility identifiers, and a production logged-in session.

---

## The Big Picture

ToastPilot is a fully autonomous agentic QA platform built on top of the **ToastUnifiedInventory** module. It handles the entire quality assurance lifecycle end-to-end — from a developer merging a PR to Jira evidence being attached — with **zero human intervention required**.

```
Developer merges PR
        │
        ▼
GitHub Actions detects merge → sends HMAC-signed webhook
        │
        ▼
ToastPilot reads the Jira ticket, understands the change,
picks the right test flow (or generates one with AI),
runs it against the real app on a live simulator,
records a video, takes screenshots at every step,
attaches all evidence to Jira,
and posts a Slack notification — all automatically.
```

If something breaks, a Jira bug ticket is created in one tap.  
If the change has no existing test coverage, AI writes the test code from the developer's own Swift source.

---

## Feature Showcase

### 🤖 Fully Autonomous Execution
- Drives **real Toast Operator Production** screens via Appium XCUITest — no mocks, no simulators of simulators
- **102 action methods** covering every user interaction across Cycle Count, Product Catalog, and Invoice Scanning
- Keeps the simulator session warm with `AGENT_NO_RESET=true` — no repeated login delays, no reCAPTCHA
- Automatically boots the simulator, launches the app, and starts recording before the first step

### 🎤 Voice Commands
- Click the **🎤 Voice** button in the dashboard and speak naturally
- *"Run full regression"* → starts the 50-step full-app test
- *"Test invoice scanning"* → picks the right flow automatically
- *"SMB-1168"* → fetches the Jira ticket and generates a targeted plan
- Powered by the Web Speech API — works entirely in-browser, no plugins needed

### 💬 Natural Language Test Dispatch
- Type any description: *"cycle count full regression"*, *"product catalog filters"*, *"upload invoice flow"*
- Intent matching with stopword filtering, token scoring, and phrase detection
- Combined flows: *"login flow and edit item flow"* runs both sequentially, deduplicating shared setup steps
- Falls back to OpenAI when no rule-based match is found

### 🔄 Autonomous PR-Merge QA Pipeline
When a `ToastUnifiedInventory` PR merges to `main`:

```
PR merged → GitHub Actions extracts SMB-* ticket
         → HMAC-SHA256 signed webhook → ToastPilot server
         → Jira ticket fetched (summary, description, AC, components)
         → Best matching flow selected from 22-flow library
         → Tests run automatically against Production simulator
         → Screenshots + MP4 video attached to Jira
         → Slack notification posted with pass/fail + evidence links
```

- Only **SMB-*** tickets trigger this — other projects in the shared repo are ignored
- No ngrok needed — self-hosted GitHub Actions runner on the corporate network reaches the Mac directly
- Webhook payload verified with **HMAC-SHA256** on raw bytes using `timingSafeEqual`

### 🧠 Dynamic Flow Generator (AI writes the test plan)
No pre-built flow matching the PR? The agent generates one on the fly:

1. Fetches the **unified diff** from GitHub Enterprise API (filtered to `ToastUnifiedInventory` Swift/TS files)
2. Sends diff + Jira ticket + acceptance criteria to **OpenAI GPT-4o**
3. AI composes a targeted test sequence from the **80-action catalog** — hallucinated actions are safety-filtered
4. Generated flow is **persisted to `inventory-flows.json`** and executed immediately in the same pipeline
5. If the diff is backend/infra-only with no UI changes → skip test, notify Slack *"needs manual testing"*

### ⚙️ Automated TypeScript Code Generation (AI writes the test code)
When a developer ships a brand-new feature with new Swift accessibility identifiers:

**Step 1 — Locator Codegen** (`npm run locators:generate`):
- Scans all `.accessibilityIdentifier("...")` calls in the developer's Swift source files under `ToastUnifiedInventory/Sources`
- Generates/updates `generated-locators.ts` with every new accessibility ID
- Automatically **promotes new static locators** into the `L` map in `FlowActions.ts`
- Dynamic IDs get both a `BEGINSWITH` predicate and indexed XPath variants

**Step 2 — Feature Codegen** (`npm run feature:generate -- --ticket=SMB-1234`):
- Uses OpenAI to generate **all four automation artifacts at once**:
  - New `async` action methods in `FlowActions.ts`
  - New flow entry in `inventory-flows.json`
  - New keyword mapping in `JiraPlanSynthesizer.ts`
  - New handler entries in `AgentOrchestrator.ts`
- Inserted live into the running files — **zero human code editing required**
- The next test run picks up the new feature coverage automatically

### 🩹 Deep Self-Healing (113 healing touchpoints)
The agent never gives up on a step just because a selector changed:

- **Multi-candidate waits** — tries `[selectorA, selectorB, selectorC]` in parallel; first to appear wins
- **Retry loops** — back-navigation retries up to 8 times across the iOS navigation stack
- **Native iOS nav-bar fallback** — `//XCUIElementTypeNavigationBar//XCUIElementTypeButton[1]` catches screens that don't expose a custom back button
- **Scroll-to-reveal** — scrolls up/down to bring filter chips, inventory fields, and detail sections into view before asserting
- **Atomic field replacement** — `mobile: replaceText` replaces search/input field content atomically, eliminating garbled text from partial clears
- **Graceful degradation** — steps that encounter optional UI (no invoices in list, product type without inventory fields) warn and continue instead of failing the run
- **Fuzzy page-source scan** — `SelectorHealer` scans the live Appium page source when known selectors miss, promoting healed selectors back to the registry
- **Demo injection** — `AGENT_DEMO_INJECT_FAILURE=true` deliberately introduces a broken selector, heals it live on stage, and shows the healing event in the dashboard

### 🗂️ 22 Ready-to-Run Test Flows

| Module | Flow | Description |
|--------|------|-------------|
| **Full App** | `full-regression` | All 3 modules, 50+ steps, end-to-end |
| **Full App** | `full-smoke` | All 3 modules, happy path |
| **Cycle Count** | `cycle-count-smoke` | Full regression |
| **Cycle Count** | `cycle-count` | Select sheet → count → submit |
| **Cycle Count** | `cycle-count-from-template` | Create count sheet from template |
| **Cycle Count** | `edit-item` | Edit item base price |
| **Cycle Count** | `add-new-item` | Add new item to count sheet |
| **Cycle Count** | `add-item-location` | Add location to existing item |
| **Cycle Count** | `post-submission-ui` | Post-submission success UI |
| **Product Catalog** | `product-catalog-regression` | Full regression |
| **Product Catalog** | `product-catalog-add-edit-delete` | Add, edit, delete a product |
| **Product Catalog** | `product-catalog-details` | Detail sections (info, inventory, orders, pricing) |
| **Product Catalog** | `product-catalog-filters` | Filter sheet (sort, category, vendor, warnings) |
| **Product Catalog** | `pc-filter-refresh` | Filter count auto-refresh after product edit |
| **Product Catalog** | `product-catalog` | Browse + search |
| **Invoice Scanning** | `invoice-scanning-regression` | Full regression |
| **Invoice Scanning** | `upload-invoice` | Capture + submit full invoice |
| **Invoice Scanning** | `invoice-scanning` | Manage invoices — browse + open |
| **Invoice Scanning** | `invoice-landscape-popup` | Landscape low-quality popup verification |
| **Auth** | `login-only` | Login flow |
| **Auth** | `logout-only` | Logout flow |
| **Smoke** | `minimal-smoke` | Login + inventory home |

### 🎯 Jira-Driven Test Planning
- Paste `SMB-1168` in the dashboard → agent fetches ticket summary, description, components, and all acceptance criteria
- Acceptance criteria lines are **automatically mapped to specific test actions** (landscape check → `verifyLowQualityPopupLandscape`, invoice list → `verifyInvoiceManagement`, etc.)
- Test plan name shown as `SMB-1168: <ticket summary>` in the dashboard and all reports

### 📎 Automatic Jira Evidence Attachment
After every run triggered by a PR merge or Jira ticket:
- All **screenshots** attached as a visual gallery comment on the Jira ticket
- **MP4 video recording** of the full run attached
- **Step-by-step pass/fail table** included in the comment
- Confidence score, risk level, and recommended next action included

### 🐛 One-Tap Jira Bug Filing
During any failed run in the dashboard:
- Click **🐛 File Bug** → `POST /api/jira/create-bug`
- Creates a linked bug ticket instantly with steps to reproduce, failure detail, run ID, and feature context
- Ticket key shown in the dashboard (`SMB-1201 ✓`) and automatically included in the Slack report
- Bug is linked to the original story ticket

### 🔁 Sprint Bug Bash — Bulk Testing in One Tap

Before a sprint demo or release, the whole team usually sits together and manually tests every Jira ticket completed that sprint — 10 to 15 tickets, one by one. **Bug Bash mode automates this entire session.**

1. Open the **Sprint Bug Bash** panel in the dashboard
2. Paste all sprint ticket IDs (one per line, comma-separated, or mixed — anything matching `SMB-NNN` is extracted)
3. Click **Run Bug Bash** — that's it

ToastPilot runs each ticket sequentially through the same full pipeline as a single PR-merge trigger:

```
SMB-123 → Jira fetch + synthesis → agent run → attach screenshots + video → Jira comment
SMB-124 → Jira fetch + synthesis → agent run → attach screenshots + video → Jira comment
SMB-125 → …
           ↓
Aggregate Slack summary: "Bug Bash complete — 12/14 passed ✅, 2 failed ❌"
```

- **Live queue view** in the dashboard shows each ticket as pending `○` → running `◎` → passed `✅` / failed `❌`
- Evidence (screenshots + MP4 video) automatically attached to every Jira ticket as it completes
- **Stop** button cancels cleanly after the current ticket finishes — already-completed evidence stays attached
- Final **aggregate Slack Block Kit summary** with per-ticket pass/fail table and step counts
- No server restart needed — the queue runs in the background while you watch the live dashboard

### 💬 Slack Notifications

| Event | Notification |
|-------|-------------|
| Tests passed | `✅ SMB-1168 validated — 47/47 steps passed · 📸 12 screenshots · 🎥 Video recording` |
| Tests failed | `❌ SMB-1168 — 3 steps failed · 🐛 Bug filed: SMB-1201 · evidence links` |
| AI-generated flow ran | `✅ SMB-1170 — AI-generated flow "Invoice Filter Refresh" passed · evidence` |
| Untestable PR | `⚠️ SMB-1169 needs manual testing — backend-only change detected by AI` |
| Bug Bash complete | `✅ Bug Bash — 12/14 passed · per-ticket pass/fail table with step counts` |
| Manual report | Full structured report with confidence, risk, scenarios, evidence — triggered from dashboard |

### 🎬 Full-Run Video Recording
- Records the **entire test session** as an MP4 using `simctl recordVideo`
- Automatically kills stale `simctl` processes before starting (prevents `EBUSY` lock errors on session reuse)
- 15-second post-finish poller in the dashboard waits for `simctl` to flush the file before showing the player
- Video displayed inline in the dashboard with a native HTML5 player

### 🛠️ Live Build Freshness — Never Test Stale Code
A QA agent is only trustworthy if it runs against the latest code. ToastPilot keeps the simulator build in sync with `main` automatically:
- **Commits-behind-main badge** — `GET /api/git/status` fetches `origin/main`, compares it to the SHA the installed `.app` was built from (`.build-sha` sidecar + `.build-state.json`), and the dashboard polls it every 5 minutes
- **One-tap rebuild** — `POST /api/build` spawns `build-operator-app.ts` (`xcodebuild` against the `ToastOperator Production` scheme) **detached**, so the server stays responsive during the 10–20 minute build
- **Live build log** — the dashboard polls `/api/build/status` every 3 seconds and streams the tail of the build output
- **Scheme + bundle verification** — the built `.app` is checked against the expected `TOAST_ENVIRONMENT` (`Production`) and `CFBundleIdentifier` (`com.toasttab.toastoperator`) before it's copied into place
- **SHA stamping** — on success the new `origin/main` short SHA is written to `.build-sha`, flipping the badge to **✓ up to date**
- **Safety guards** — refuses to build while a test run is in progress or another build is already running; reconciles a stale `inProgress` flag on server startup if the build PID is gone

### 📊 Live Dashboard
Open **http://localhost:5177** during any run:

| Panel | What it shows |
|-------|--------------|
| **Command input** | Free-text, voice, flow dropdown, or Jira ticket ID |
| **Step timeline** | Live step-by-step progress — pending / running / passed / failed / healed |
| **Screenshots** | Per-step inline screenshots with expand |
| **Video player** | Full-run MP4, appears automatically after the run |
| **Healing events** | Every self-heal: original selector → healed selector → strategy used |
| **AI Failure Analysis** | Structured breakdown: what failed, why, reproduction steps, recommended fix |
| **Executive Summary** | Confidence score, risk, scenario coverage, exportable JSON/HTML |
| **Strategic Insight Trace** | Copilot reasoning — change detection, risk mapping, flow recommendation |
| **Jira Test Planner** | Enter any SMB-* ticket → generate and run its test plan in one click |
| **🐛 File Bug button** | Appears on failure — creates Jira bug ticket in one tap |
| **Send Slack Report** | One-click formatted Slack notification with all evidence links |
| **Sprint Bug Bash** | Paste 10–15 sprint ticket IDs → runs all sequentially, attaches evidence, aggregate Slack summary |
| **Git Status** | Commits ahead of main, last build SHA, build freshness |

### 🤖 Leadership Copilot
Before every run, the Copilot performs a preflight analysis:
- **Change Detection** — reads git diff to identify which `ToastUnifiedInventory` files changed
- **Risk Assessment** — High / Medium / Low risk based on impacted modules and change surface
- **Scenario Generation** — derives test scenarios from the change set
- **Flow Recommendation** — suggests the most targeted command to run
- Shown as a **Strategic Insight Trace** in the dashboard alongside the test run

---

## Architecture

> 📐 **Full architecture flow diagram:** see the rendered Mermaid diagram in [DESIGN.md](DESIGN.md#system-architecture).
>
> 🔧 **Engineer's reference** (every endpoint, env var, event type, and flow): [TECHNICAL.md](TECHNICAL.md).

```
┌─────────────────────────┐    WebSocket + REST    ┌──────────────────────────┐
│     React Dashboard      │◄──────────────────────►│   Agent Server :9477     │
│  voice · text · Jira     │                         │   Express + WebSocket    │
└─────────────────────────┘                         └────────────┬─────────────┘
                                                                 │
          ┌──────────────────────────────────────────────────────┤
          │                          │                           │
 ┌────────▼────────┐    ┌────────────▼──────────┐   ┌──────────▼────────────┐
 │ AgentOrchestrator│    │  TestPlanGenerator     │   │   CopilotService       │
 │ Plan → Execute   │    │  22 flows · Jira AC    │   │   Risk · Scenarios     │
 │ Video recording  │    │  Intent matching        │   │   Change detection     │
 └────────┬────────┘    └────────────────────────┘   └───────────────────────┘
          │
 ┌────────┴────────────────────────────────────────────────────────┐
 │                              │                                  │
 ┌────────▼────────┐   ┌────────▼──────────┐   ┌─────────────────▼──────────┐
 │  FlowActions     │   │  SelectorHealer    │   │  DynamicFlowGenerator      │
 │  102 actions     │   │  Registry + fuzzy  │   │  OpenAI + PR diff          │
 │  113 heal points │   │  page-source scan  │   │  → custom test flow        │
 └────────┬────────┘   └───────────────────┘   └────────────────────────────┘
          │
 ┌────────▼──────────────────────────────────────┐
 │  AppiumSession → iOS Simulator                 │
 │  ToastOperator Production                      │
 │  ToastUnifiedInventory (real app, real screens)│
 └───────────────────────────────────────────────┘

GitHub Actions ─► POST /api/webhook/pr-merged (HMAC-SHA256) ─► Autonomous QA Loop
                                                                ├── Jira synthesis
                                                                ├── Run tests
                                                                ├── Attach Jira evidence
                                                                └── Slack notification

LocatorCodegen ─► reads developer Swift source ─► generates selectors ─► FlowActions.ts
FeatureCodegen ─► Jira AC + new locators ─► OpenAI ─► action methods + flow JSON (zero human edits)
```

---

## Quick Start

### Prerequisites
- Xcode + iOS Simulator (iPhone 17 Pro recommended)
- Node.js 20+
- Appium 3: `npx appium`

### Configure
```bash
cd ToastOperatorApp/ToastUnifiedInventory/ai-qa-agent
cp .env.example .env
```

Minimum `.env`:
```bash
TOAST_TEST_EMAIL=your-test@toasttab.com
TOAST_TEST_PASSWORD=...
```

Full `.env` to unlock every feature:
```bash
# AI features
OPENAI_API_KEY=sk-...

# Slack notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
SLACK_REPORTER_NAME=ToastPilot

# Jira evidence + bug filing
JIRA_BASE_URL=https://toasttab.atlassian.net
JIRA_USER_EMAIL=...
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=SMB

# Autonomous PR-merge QA
GITHUB_WEBHOOK_SECRET=...           # same value in GitHub repo secret
AGENT_PUBLIC_URL=http://160.253.x.x:9477
GITHUB_TOKEN=...                    # read:repo on github.toasttab.com
GITHUB_REPO=toasttab/operator-app-ios
GITHUB_API_HOST=github.toasttab.com/api/v3
```

### Run (one command)
```bash
npm install && npm run demo
```
Opens **http://localhost:5177** — type, speak, or paste a Jira ticket ID.

### Manual mode
```bash
npx appium          # terminal 1
npm run dev         # terminal 2
```

### CLI (no dashboard)
```bash
npx tsx agent/cli.ts "full regression"
npx tsx agent/cli.ts "SMB-1168"
npx tsx agent/cli.ts "upload invoice flow"
```

---

## Automated Code Generation Commands

```bash
# Scan developer Swift source → generate new selectors → promote into FlowActions.ts
npm run locators:generate

# Scan ALL Swift files (not just changed)
npm run locators:generate:all

# Generate all test automation code for a new Jira ticket (dry run first)
npm run feature:generate -- --ticket=SMB-1234 --dry-run
npm run feature:generate -- --ticket=SMB-1234
```

---

## Autonomous PR-Merge Setup

Add two secrets to the GitHub repository (`Settings → Secrets → Actions`):

| Secret | Value |
|--------|-------|
| `TOASTPILOT_WEBHOOK_URL` | `http://<your-mac-ip>:9477/api/webhook/pr-merged` |
| `TOASTPILOT_WEBHOOK_SECRET` | Any strong random string (same as `GITHUB_WEBHOOK_SECRET` in `.env`) |

That's it. The GitHub Actions workflow (`.github/workflows/toastpilot-pr-auto-qa.yml`) handles the rest. No ngrok, no public cloud — the self-hosted runner reaches the Mac directly over the corporate network.

---

## Security

- All credentials in `.env` only — never in source code, never in logs
- GitHub webhook verified with **HMAC-SHA256** comparing raw digest bytes via `timingSafeEqual` (not hex strings)
- CORS restricted to `localhost:5177` — the API is not accessible cross-origin
- `AGENT_DEMO_INJECT_FAILURE` defaults **OFF** (`=== "true"` explicit check)
- Only **SMB-*** Jira tickets trigger autonomous QA — the monorepo's other projects are ignored
- All GitHub Actions PR event values passed via `env:` (no shell injection from PR titles/bodies)
- `.env` is gitignored — no secrets are ever committed

---

## Project Layout

```
ai-qa-agent/
├── agent/
│   ├── core/
│   │   ├── AgentOrchestrator.ts      # Run lifecycle, video recording, step execution
│   │   ├── DynamicFlowGenerator.ts   # PR diff + OpenAI → custom test flow
│   │   ├── FeatureCodegen.ts         # Jira AC + locators → full TS automation code
│   │   ├── OpenAIClient.ts           # GPT-4o: test plans, failure analysis, dynamic flows
│   │   ├── SelectorHealer.ts         # Registry + fuzzy page-source healing
│   │   ├── TestPlanGenerator.ts      # 22 flows, Jira AC steps, intent matching
│   │   └── FailureExplainer.ts       # Plain-English failure explanation
│   ├── executor/
│   │   ├── FlowActions.ts            # 102 action methods, 113 healing touchpoints
│   │   ├── AppiumSession.ts          # Appium driver, replaceFieldText, scrolls, orientation
│   │   ├── LocatorCodegen.ts         # Swift source → generated-locators.ts + FlowActions.L
│   │   ├── generated-locators.ts     # Auto-generated selector registry
│   │   ├── loginFlow.ts              # Login / credential handling
│   │   └── simulatorConfig.ts        # Auto-detect simulator UDID + iOS version
│   └── types.ts
├── copilot/
│   ├── CopilotService.ts             # Preflight: risk, scenarios, recommended command
│   ├── changeDetection/              # Git diff → impacted module → flow mapping
│   ├── failure/FailureAnalysisService.ts
│   └── reporting/ReportGenerator.ts  # Executive summary JSON + HTML
├── jira/
│   ├── JiraClient.ts                 # Fetch tickets, attach evidence, file bugs
│   └── JiraPlanSynthesizer.ts        # AC → test steps, keyword mapping
├── server/
│   ├── index.ts                      # REST + WebSocket + PR-merge webhook + bug-bash endpoints
│   ├── AgentService.ts               # Run queue and lifecycle
│   ├── BugBashQueue.ts               # Sequential sprint ticket runner — Jira + evidence + Slack
│   └── EventBus.ts                   # WebSocket event broadcast
├── dashboard/src/
│   ├── App.tsx                       # Full dashboard — voice, Jira planner, bug button, all panels
│   ├── hooks/useAgentWebSocket.ts    # WebSocket state, video poller, hydration
│   └── types.ts
├── knowledge/
│   ├── inventory-flows.json          # 22 named flows + AI-generated dynamic flows
│   └── accessibility-registry.json   # A11y ID registry for selector healing
├── .github/workflows/
│   └── toastpilot-pr-auto-qa.yml     # GitHub Actions: PR merge → autonomous QA
└── scripts/
    ├── demo.ts                        # One-command hackathon demo
    ├── generate-feature.ts            # Feature codegen CLI
    ├── generate-locators.ts           # Locator codegen CLI
    ├── build-operator-app.ts          # Xcodebuild + copy .app
    └── copilot-merge-test.ts          # Jenkins post-merge CI entry point
```

---

## Integration Notes

- **Zero new app screens** — drives existing `CycleCountView`, `CountSheetsItemsView`, `ProductCatalogView`, `InvoiceManagementView` via their real accessibility identifiers
- **Self-contained** — entirely within `ai-qa-agent/`, no changes to the main app source
- Reuses `automation/app/ToastOperator.app` path convention
- Works **offline without OpenAI** — rule-based flow matching + basic failure logging always available
- Works **without Jira/Slack** — all integrations are optional; the core test runner is always functional
