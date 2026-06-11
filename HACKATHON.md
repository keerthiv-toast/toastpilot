# ToastPilot — Hackathon Project Description

## The Problem We Solved

Quality assurance at Toast is a manual, slow, and expensive bottleneck. Every time a developer merges a change to the **ToastUnifiedInventory** module — the iOS feature powering Cycle Count, Product Catalog, and Invoice Scanning for thousands of restaurant operators — someone has to manually open the app, navigate through dozens of screens, and verify nothing broke. This takes hours. It depends on people remembering what to check. It doesn't scale. And it produces zero audit trail for the product and compliance teams who need proof that critical inventory flows actually work.

We built **ToastPilot** to eliminate that bottleneck entirely.

---

## What We Built

ToastPilot is a fully autonomous AI QA agent that does the work of a **Senior QA Engineer** — reading changelogs, designing test plans, executing them against the real app, filing bugs with evidence, and reporting results to the team. It does this against the real **Toast Operator Production** iOS app — not a mock, not a simulator of a simulator, not a scripted demo. It drives actual production screens on a live iOS Simulator using the same accessibility identifiers that ship in the product. When a developer merges a PR, ToastPilot detects it, understands what changed, runs the right tests, records a video, and posts the evidence directly to Jira and Slack — all without a single human action.

We wrote **14,320 lines of TypeScript** across **48 files** in the hackathon window. The project spans an Appium XCUITest execution engine, a React dashboard, an Express WebSocket server, a GitHub Actions CI pipeline, OpenAI integrations, a Jira client, a Slack reporter, a dynamic test flow generator, and an automated code generation system that can write its own test code from a developer's Swift source files.

---

## How It Works End to End

### The Moment a PR Merges

The moment a developer merges a `ToastUnifiedInventory` PR to main, a GitHub Actions workflow fires. It reads the PR title, branch name, and body to extract the associated Jira ticket (matching the `SMB-*` format). It then signs a webhook payload with HMAC-SHA256 and POSTs it to the ToastPilot server running on the QA engineer's Mac.

The server receives the webhook, verifies the signature using `timingSafeEqual` on raw digest bytes (not hex strings — a subtle but real security distinction), and begins the autonomous QA loop:

1. It calls the Jira API to fetch the full ticket — summary, description, acceptance criteria, and component labels.
2. It maps the ticket to the best matching test flow from a library of 22 pre-built flows covering every user journey in the ToastUnifiedInventory module.
3. If a good match is found, it runs the flow immediately.
4. If no good match exists, it invokes the **Dynamic Flow Generator**.

### The Dynamic Flow Generator

This is one of the most technically impressive pieces of the project. When a ticket doesn't map to an existing flow, ToastPilot doesn't give up — it **generates a custom test flow from scratch using OpenAI**.

It fetches the unified diff of the merged PR from GitHub Enterprise's API, filters it down to only `ToastUnifiedInventory` Swift and TypeScript files, and sends it to GPT-4o alongside the Jira ticket summary and acceptance criteria. OpenAI reads the diff, understands what UI changed, and composes a targeted test sequence using only the 80 known actions in our catalog. We include a safety filter that rejects any action name hallucinated by the model — if OpenAI invents a method that doesn't exist, it's silently removed and only real, executable actions survive. The generated flow is then persisted to `inventory-flows.json` and executed immediately in the same pipeline.

If the diff contains only backend or infrastructure changes with no UI impact, OpenAI returns `{ "notTestable": true }` and we send a Slack notification saying the ticket needs manual testing instead.

### The Test Execution Engine

At the core of ToastPilot is a 2,210-line Appium XCUITest execution engine (`FlowActions.ts`) with **102 action methods** covering every meaningful user interaction across three major product modules. Each method drives real iOS screens through accessibility identifiers — tapping buttons, filling forms, scrolling lists, navigating the full iOS navigation stack, rotating the device, capturing photos through the camera preview, and verifying that the right UI is visible after each action.

We run the agent with `AGENT_NO_RESET=true` which keeps the iOS Simulator session warm between runs. This means the app is already logged in when a test starts — no repeated authentication delays, no reCAPTCHA challenges. The session persists across multiple test runs just as a real QA engineer's device would.

Video recording starts automatically after `launchApp`. We use `simctl recordVideo` to capture the entire session as an MP4. We specifically solved the `EBUSY` locking problem that occurs on session reuse — before starting a new recording, we kill any stale `simctl` process from a previous run, wait 1.5 seconds for the I/O channel to release, then start fresh. The dashboard includes a 15-second post-finish poller that waits for `simctl` to flush and finalize the MP4 before showing it to the user.

### Self-Healing Selectors — 113 Healing Touchpoints

One of the biggest practical challenges with mobile UI testing is that selectors break. Developers rename accessibility identifiers, refactor views, or move elements around. Traditional test automation collapses the moment a selector changes. ToastPilot doesn't.

We built **113 healing touchpoints** directly into the test actions:

- **Multi-candidate waits**: Every critical navigation uses `waitForAnyDisplayed([A, B, C], timeout)` — the first selector to appear wins. If the primary ID changed but the fallback is still there, the test continues without interruption.
- **Retry loops**: Back-navigation steps attempt up to 8 times, trying the custom back button, the accessibility-tagged back button, and the native iOS navigation bar button (`//XCUIElementTypeNavigationBar//XCUIElementTypeButton[1]`) in sequence.
- **Scroll-to-reveal**: Filter chips, inventory input fields, and product detail sections scroll into view before any assertion, so a slightly different layout doesn't cause a false failure.
- **Atomic text replacement**: We use `mobile: replaceText` (not `setValue` or `clearValue`) to atomically replace search and input field content. This eliminates the class of bug where partial clears cause garbled repeated characters — we encountered this in production during the hackathon and fixed it.
- **Graceful degradation**: Steps that encounter optional UI (no invoice rows in list, product type without inventory fields) log a warning and continue instead of failing the run. Only genuinely broken app behavior throws.
- **Fuzzy page-source scan**: The `SelectorHealer` module scans the live Appium page source when all known selectors miss, looks for close matches, and promotes the healed selector back to the registry so future runs use it directly.
- **Demo failure injection**: `AGENT_DEMO_INJECT_FAILURE=true` deliberately introduces a broken selector (`StartCountingButton_WRONG_DEMO`) and then heals it in real time, showing the healing event in the dashboard. This lets us demonstrate the self-healing capability live without needing an actual app bug.

### The Navigation Stack Problem

A subtle but real challenge we solved: the ToastUnifiedInventory module uses iOS SwiftUI navigation stacks. When you navigate deep into Product Catalog or Invoice Scanning, tapping the Inventory tab bar button does *not* pop the navigation stack — you end up with the Inventory tab visible but the pushed screens still on top. Subsequent test steps then fail to find the home screen elements they expect.

We solved this with dedicated back-navigation action methods (`backFromCountingToHome`, `backFromProductCatalogToHome`, `backFromInvoiceToHome`) that intelligently unwind the stack before every cross-module transition in the full-app flows. Each uses a retry loop with multiple back button candidates and confirms arrival at the home screen before moving on.

### Jira Integration

Every test run triggered by a Jira ticket or PR merge produces a complete evidence package that gets posted directly to the ticket:

- A screenshot gallery showing every captured frame from the test run
- The full MP4 video recording attached as a file
- A step-by-step pass/fail table showing which actions succeeded, which healed, and which failed
- Confidence score, risk level, and the generated test scenarios

If the test fails, there is a **single-tap bug filing button** in the dashboard. One click calls `POST /api/jira/create-bug`, and ToastPilot creates a linked bug ticket with the failure detail, steps to reproduce, run ID, and feature context pre-filled. The created ticket key appears immediately in the dashboard and is automatically included in the Slack report.

When a Jira ticket ID is typed into the dashboard (or processed by the autonomous pipeline), the agent also reads the acceptance criteria and maps individual AC lines to specific test actions. A criterion mentioning "landscape" maps to `verifyLowQualityPopupLandscape`. A criterion about invoice management maps to `verifyInvoiceManagement`. The test plan isn't just the flow template — it's the flow augmented with the specific scenarios the product team wrote.

### Slack Notifications

Every autonomous run produces a rich Slack notification:

- ✅ Passed: ticket key, step count, screenshot count, video link, Jira evidence link
- ❌ Failed: which steps failed, auto-filed bug ticket link, evidence links
- 🤖 AI-generated flow: noted with the AI-generated flow name so the team knows it was dynamically created
- ⚠️ Untestable: plain message explaining the change was backend-only and needs human review

The notifications are structured Slack Block Kit messages with proper formatting, color-coded attachments (green for pass, red for fail), and clickable evidence links.

### Automated Code Generation — AI That Writes Its Own Tests

This is the most forward-looking capability in the project: **ToastPilot can write its own test code when a developer ships a new feature**.

**Locator Codegen** (`npm run locators:generate`) scans the developer's Swift source files under `ToastUnifiedInventory/Sources`, reads every `.accessibilityIdentifier("...")` call, and automatically generates `generated-locators.ts` with every discovered accessibility ID. New IDs are promoted directly into the `L` selector map in `FlowActions.ts` — the test code gets updated to know about the new UI elements without anyone touching a file.

**Feature Codegen** (`npm run feature:generate -- --ticket=SMB-1234`) goes further. Given a Jira ticket and the newly promoted locators, it uses OpenAI to generate all four artifacts needed to test a new feature:
1. New `async` action methods in `FlowActions.ts` with proper waits, retries, and error messages
2. A new flow entry in `inventory-flows.json` with the correct step sequence
3. A new keyword mapping in `JiraPlanSynthesizer.ts` so the flow can be found by voice or text
4. New handler entries in `AgentOrchestrator.ts` so the orchestrator knows to call the new methods

All four files are updated in place. The next test run picks up the new feature's test coverage with zero human code editing.

### Sprint Bug Bash — One Tap to Test the Entire Sprint

Every two weeks, the team sits together for a bug bash: someone opens Jira, reads out the sprint tickets one by one, and a QA engineer tests each one manually. It's slow, it's exhausting, and it still misses things because humans get tired.

ToastPilot replaces the entire bug bash session with a single paste-and-click.

Open the **Sprint Bug Bash** panel in the dashboard. Paste all the sprint ticket IDs — one per line, comma-separated, or in any format. ToastPilot extracts every `SMB-NNN` key automatically. Hit **Run Bug Bash**.

From that point forward, ToastPilot does exactly what the team was doing manually, ticket by ticket:

1. Fetches the Jira ticket (summary, description, acceptance criteria)
2. Synthesizes a test plan for that specific ticket
3. Runs the agent against the real app
4. Attaches screenshots and the MP4 recording directly to that Jira ticket as evidence
5. Posts a structured comment to the ticket with the pass/fail result and step counts
6. Moves to the next ticket

The dashboard shows a live queue. Each ticket starts as a hollow circle `○`, lights up with a pulsing `◎` when it's running, and resolves to `✅` or `❌` when it finishes — along with the exact step counts. When every ticket is done, a single **aggregate Slack message** summarizes the full sprint: how many passed, how many failed, and a per-ticket table with evidence links.

The team can watch the entire sprint bug bash happen in real time on the dashboard while drinking coffee — or just come back when Slack pings them.

### The Live Dashboard

The React dashboard at `http://localhost:5177` is the control center for everything:

- **Command input**: type anything, or speak via the **🎤 Voice** button (Web Speech API, in-browser)
- **Flow selector**: dropdown of all 22 named flows organized by module
- **Jira Planner**: enter any `SMB-*` ticket → the agent fetches it, synthesizes a plan, and one click runs it
- **Step timeline**: live step-by-step progress with color-coded status (pending, running, passed, failed, healed)
- **Screenshot gallery**: per-step inline screenshots with expand
- **Video player**: full MP4 recording, appears automatically after the run with post-flush polling
- **Healing events panel**: every self-heal shown with original selector → healed selector → strategy used
- **AI Failure Analysis**: when a step fails, a structured breakdown explains what happened, why, and how to reproduce it
- **Executive Summary**: confidence score, risk level, scenario coverage, exportable as JSON or HTML
- **Strategic Insight Trace**: the Copilot's reasoning — which files changed, which modules are impacted, risk assessment, recommended command
- **🐛 File Bug button**: visible on failure, creates a Jira bug in one tap
- **Send Slack Report button**: posts a formatted report with all evidence to the team channel
- **Sprint Bug Bash panel**: paste all sprint ticket IDs → runs every one sequentially → aggregate Slack summary
- **Git Status**: shows how many commits ahead of main the current build is, last build SHA, build freshness

Everything is streamed over a WebSocket connection. Steps update in real time as they execute. Screenshots appear as they're captured. The healing event appears the moment a selector heals. There is no polling delay — the dashboard is live.

### The Copilot

Before every run, a preflight analysis runs automatically:

- **Change Detection**: reads the git diff to identify which `ToastUnifiedInventory` files changed since the last build
- **Risk Assessment**: scores the change as High, Medium, or Low based on which modules are touched and how many lines changed
- **Scenario Generation**: derives the test scenarios the run should cover from the change set
- **Flow Recommendation**: suggests the most targeted command to run for the current diff

This context is shown in the dashboard as the **Strategic Insight Trace** — a step-by-step reasoning log that gives leadership visibility into *why* the agent chose the test it chose, not just what it ran.

---

## The Numbers

| Metric | Value |
|--------|-------|
| Lines of TypeScript/TSX written | **14,320** |
| Source files | **48** |
| Named test flows | **22** |
| Total test steps across all flows | **372** |
| Action methods | **102** |
| Self-healing touchpoints | **113** |
| iOS modules covered | **3** (Cycle Count, Product Catalog, Invoice Scanning) |
| User journeys automated | **Full app regression, full app smoke, + 20 targeted flows** |
| External integrations | **5** (Appium, OpenAI, Jira, Slack, GitHub) |
| Bug Bash capacity | **Unlimited** sprint tickets — tested sequentially in one tap |

---

## 22 Test Flows — Every User Journey Covered

We didn't build a proof of concept with one flow. We built a production-quality test library covering the entire ToastUnifiedInventory module:

**Cycle Count** — the core inventory counting workflow:
- Full regression, standard count, count from template, edit item, add new item, add item location, post-submission UI validation

**Product Catalog** — the product management system:
- Full regression, add/edit/delete, detail sections (info, inventory, orders, pricing & costs), filter sheet (sort, category, vendor, warnings), filter count auto-refresh after edits, browse and search

**Invoice Scanning** — the invoice capture and management system:
- Full regression, upload new invoice (capture + review + submit), manage existing invoices, landscape low-quality popup verification

**Cross-module** — full app flows:
- Full app regression (all three modules, 50+ steps), full app smoke (all modules, happy path)

**Auth**:
- Login only, logout only, minimal smoke

All 22 flows are available from the dashboard dropdown, the CLI, by voice command, by natural language text, by Jira ticket ID, triggered autonomously by PR merge, or run in bulk across an entire sprint's worth of tickets via the Bug Bash panel.

---

## What Makes This Different from Traditional Test Automation

A Senior QA Engineer, when a PR lands, does seven things:
1. Reads the diff and decides what to test
2. Writes or updates the test cases
3. Runs the tests (manually or through CI)
4. Interprets the results
5. Files bugs
6. Attaches evidence to the Jira ticket
7. Notifies the team in Slack

**ToastPilot does every single one of those steps.** Not "assists with" — does. On its own. On every merge. The developer merges a PR and walks away. By the time they check Slack, there's already a test result, a video, screenshots attached to their ticket, and either a green checkmark or a filed bug with reproduction steps waiting for them.

And there's an eighth thing a Senior QA Engineer does at the end of every sprint: sit in the bug bash and manually test every ticket the team completed. ToastPilot does that too — paste the sprint ticket IDs, hit one button, and go get coffee. The entire sprint's test evidence is in Jira and a Slack summary is in the channel before you come back.

The Dynamic Flow Generator means the agent doesn't need pre-written tests to handle new features — it reads the PR diff and writes the test plan itself. The Feature Codegen means it can also write the test *code*, not just the plan. The self-healing means it doesn't break when developers refactor their UI. The Copilot means it explains its reasoning, not just its results.

This is not a demo project. Every component described here is real, tested against the production Toast Operator app, and wired together into a single autonomous pipeline.

---

## Technical Stack

| Layer | Technology |
|-------|-----------|
| Test execution | Appium 3 + XCUITest driver against iOS Simulator |
| Agent server | Node.js + Express + WebSocket (ws) |
| Dashboard | React 18 + Vite + TypeScript |
| AI | OpenAI GPT-4o-mini (test plans, failure analysis, dynamic flows, code generation) |
| iOS automation | `mobile: replaceText`, `simctl recordVideo`, `xcrun simctl` |
| CI/CD integration | GitHub Actions with HMAC-SHA256 webhook verification |
| Jira | Atlassian REST API v3 (fetch tickets, attach evidence, create bugs) |
| Slack | Incoming Webhooks + Block Kit structured messages |
| Language | TypeScript throughout — server, agent, dashboard, scripts |

---

## Why ToastPilot Should Win

Most hackathon QA tools are demos. They show a happy path on a mock app with pre-recorded responses. ToastPilot is a production-quality autonomous system running against the real Toast Operator app, integrated with the real development workflow, solving a real problem that costs Toast engineering time every single sprint.

It is **fully autonomous** — not "mostly automated with human oversight." When a PR merges and comes back with evidence in Jira and a Slack notification, no human was involved.

It is **self-healing** — not "stable until something changes." The 113 healing touchpoints mean the agent adapts to UI changes without requiring test maintenance on every PR.

It is **self-extending** — not "covers what we wrote tests for." The Dynamic Flow Generator and Feature Codegen mean the agent can handle new features it has never seen before, both in terms of what to test and how to test it.

It is **sprint-aware** — not just a per-PR tool. The Bug Bash panel means the entire team's sprint testing happens autonomously in one session. Every ticket tested, every one evidenced, summary in Slack before the retro.

And it is **deeply integrated** — not a standalone tool that someone has to remember to run. It hooks directly into the PR merge flow that every developer on the team already uses, producing evidence in the Jira tickets and Slack channels where the team already works.

This is the future of QA at Toast: zero-friction, zero-delay, zero-human quality assurance that runs automatically, explains itself clearly, and gets better with every feature the team ships.

A Senior QA Engineer brings years of domain knowledge, judgment, and craftsmanship to a team. ToastPilot does not replace that — it does the equivalent. It brings the same breadth of coverage, the same methodical evidence gathering, the same bug-filing discipline, and the same sprint-after-sprint consistency. Except it does it 24 hours a day, on every single PR, with no ramp-up time and no on-call rotation.
