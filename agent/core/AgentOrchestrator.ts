import { exec, spawn } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
import { join, dirname } from "path";
import { mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import type { ChildProcess } from "child_process";
import { v4 as uuid } from "uuid";
import type { AgentEvent, AgentRun, JiraContext, LogEntry, TestPlan, TestStep } from "../types.js";
import { TestPlanGenerator } from "./TestPlanGenerator.js";
import { FailureExplainer } from "./FailureExplainer.js";
import { AppiumSession } from "../executor/AppiumSession.js";
import { FlowActions } from "../executor/FlowActions.js";
import { SelectorHealer } from "./SelectorHealer.js";
import { completionSuccessLog } from "./flowCompletion.js";
import { CopilotService } from "../../copilot/CopilotService.js";
import type { FailureAnalysis, PreflightResult } from "../../copilot/types.js";

export type EventHandler = (event: AgentEvent) => void;

export class AgentOrchestrator {
  private readonly planGenerator = new TestPlanGenerator();
  private readonly failureExplainer = new FailureExplainer();
  private readonly copilot = new CopilotService();
  private readonly healer = new SelectorHealer();
  private readonly session = new AppiumSession();
  private run: AgentRun | null = null;
  private cancelled = false;
  private preflight: PreflightResult | undefined;
  private failureAnalyses: FailureAnalysis[] = [];
  private recordingProc: ChildProcess | null = null;

  constructor(
    private readonly onEvent: EventHandler,
    private readonly artifactsRoot = join(process.cwd(), "artifacts"),
  ) {
    this.session.setLogger((msg) => {
      if (this.run) this.log("agent", `[appium] ${msg}`, this.run.id);
    });
  }

  get currentRun(): AgentRun | null {
    return this.run;
  }

  async runCommand(command: string, jiraContext?: JiraContext, stepActions?: string[]): Promise<AgentRun> {
    this.cancelled = false;
    const runId = uuid();

    this.run = {
      id: runId,
      status: "planning",
      command,
      currentStepIndex: -1,
      healingEvents: [],
      screenshots: [],
      logs: [],
      jiraContext,
      stepActions,
    };

    this.emit({ type: "run:started", run: this.run });
    this.log("agent", `Received command: "${command}"`, runId);

    if (jiraContext) {
      this.log("agent", `Jira ticket: ${jiraContext.ticketKey} — ${jiraContext.summary}`, runId);
      this.log("agent", `Flow mapping: ${jiraContext.rationale}`, runId);
      if (jiraContext.acceptanceCriteria.length > 0) {
        this.log(
          "agent",
          `Acceptance criteria (${jiraContext.acceptanceCriteria.length}): ${jiraContext.acceptanceCriteria.slice(0, 3).join(" | ")}`,
          runId,
        );
      }
    }

    try {
      try {
        this.preflight = this.copilot.preflight({ command, jiraContext }, (message, phase) => {
          this.emit({ type: "copilot:reasoning", runId, message, phase });
        });
        this.emit({
          type: "copilot:feature-analysis",
          runId,
          analysis: this.preflight.featureAnalysis as unknown as Record<string, unknown>,
        });
        this.emit({
          type: "copilot:scenarios",
          runId,
          scenarios: this.preflight.scenarios,
          recommendedCommand: this.preflight.recommendedCommand,
        });
        this.log(
          "agent",
          `Copilot: ${this.preflight.featureAnalysis.featureName} · Risk ${this.preflight.featureAnalysis.risk} · ${this.preflight.scenarios.length} scenarios`,
          runId,
        );
      } catch (preflightErr) {
        this.log("agent", `Copilot preflight skipped: ${preflightErr instanceof Error ? preflightErr.message : String(preflightErr)}`, runId);
      }

      await this.ensureAppBuilt(runId);

      // Dynamic flows (generated from PR diff) are already written into inventory-flows.json
      // by DynamicFlowGenerator and passed here as a "dynamic-*" flowId command string.
      const plan = command.startsWith("dynamic-")
        ? (this.planGenerator.generateFromDynamicFlow(command, jiraContext) ??
           await this.planGenerator.generate(command, jiraContext))
        : await this.planGenerator.generate(command, jiraContext);

      if (stepActions && stepActions.length > 0) {
        const actionSet = new Set(stepActions);
        plan.steps = plan.steps.filter((s) => actionSet.has(s.action));
        plan.flowName = `${plan.flowName} (scenario)`;
        this.log("agent", `Scenario filter: running ${plan.steps.length} steps (${stepActions.join(", ")})`, runId);
      }

      this.run.plan = plan;
      if (plan.flowIds && plan.flowIds.length > 1) {
        this.log(
          "agent",
          `Combined plan (${plan.flowIds.length} flows, ${plan.steps.length} steps): ${plan.flowIds.join(" → ")}`,
          runId,
        );
      }
      this.run.status = "booting";
      this.emit({ type: "plan:generated", runId, plan });
      this.emit({ type: "run:status", runId, status: "booting" });

      const sessionPolicy = plan.sessionPolicy ?? "fresh";
      if (sessionPolicy === "fresh") {
        await this.session.disconnect();
      }

      const actions = new FlowActions(this.session, this.artifactsRoot);
      mkdirSync(join(this.artifactsRoot, runId), { recursive: true });

      this.run.status = "running";
      this.run.startedAt = new Date().toISOString();
      this.emit({ type: "run:status", runId, status: "running" });

      const videoPath = join(this.artifactsRoot, runId, "recording.mp4");
      const { resolveSimulatorUdid } = await import("../executor/simulatorConfig.js");
      const recordingVideoPath = videoPath;
      const recordingUdid = resolveSimulatorUdid();

      const cmdLower = command.toLowerCase();
      const isDemoFailureCommand = cmdLower.includes("demo") && cmdLower.includes("failure");
      const injectDemo =
        process.env.AGENT_DEMO_INJECT_FAILURE === "true" &&
        command.toLowerCase().includes("cycle count");

      for (let i = 0; i < plan.steps.length; i++) {
        if (this.cancelled) {
          this.run.status = "cancelled";
          break;
        }

        const step = plan.steps[i];
        this.run.currentStepIndex = i;
        step.status = "running";
        step.startedAt = new Date().toISOString();
        this.emit({ type: "step:started", runId, step, index: i });
        this.log("info", `▶ ${step.description}`, runId, step.id);

        try {
          if (isDemoFailureCommand && i === 2) {
            throw new Error("Login failed: tapped the Log In button but the credential entry screen did not appear. The app remained on the splash/onboarding screen instead of presenting the email and password fields.");
          }
          await this.executeStep(step, actions, injectDemo && step.action === "startCounting");
          if (step.status === "running") {
            step.status = "passed";
          }
          // Start recording after launchApp — wait 2s for Appium to release the I/O channel.
          // Also start on bootSimulator as a fallback for flows that skip launchApp.
          if ((step.action === "launchApp" || step.action === "bootSimulator") && !this.recordingProc) {
            const delay = step.action === "launchApp" ? 2000 : 3500;
            setTimeout(() => {
              if (!this.recordingProc) {
                this.startRecording(recordingVideoPath, recordingUdid);
                this.log("agent", "Screen recording started.", runId);
              }
            }, delay);
          }
          step.finishedAt = new Date().toISOString();

          const shotPath = await actions.saveScreenshot(step.id, runId);
          const b64 = await this.session.screenshotBase64().catch(() => undefined);
          const artifact = {
            id: uuid(),
            stepId: step.id,
            label: step.description,
            path: shotPath,
            base64Preview: b64 ? `data:image/png;base64,${b64}` : undefined,
            timestamp: new Date().toISOString(),
          };
          this.run.screenshots.push(artifact);
          step.screenshotPath = shotPath;
          this.emit({ type: "screenshot", runId, artifact });
        } catch (error) {
          if (this.cancelled) {
            step.finishedAt = new Date().toISOString();
            step.status = "skipped";
            step.error = "Cancelled by user";
            this.log("warn", `🛑 Test stopped (cancelled).`, runId, step.id);
            this.emit({ type: "step:finished", runId, step, index: i });
            this.run.status = "cancelled";
            break;
          }
          const message = error instanceof Error ? error.message : String(error);
          step.error = message;
          step.finishedAt = new Date().toISOString();
          step.status = "failed";
          this.log("error", `✗ ${step.description}: ${message}`, runId, step.id);

          const pageSource = await this.session.pageSource().catch(() => undefined);
          const failureAnalysis = await this.copilot.analyzeFailure(
            this.run,
            step,
            message,
            pageSource,
          );
          this.failureAnalyses.push(failureAnalysis);
          this.run.failureAnalysis = failureAnalysis as unknown as Record<string, unknown>;

          const explanation = await this.failureExplainer.explain(this.run, step, message, pageSource);
          this.run.failureExplanation = explanation;
          this.emit({
            type: "failure:analysis",
            runId,
            analysis: failureAnalysis as unknown as Record<string, unknown>,
          });
          this.emit({ type: "failure:explained", runId, explanation });
          this.emit({ type: "step:finished", runId, step, index: i });

          this.run.status = "failed";
          break;
        }

        this.emit({ type: "step:finished", runId, step, index: i });
      }

      if (!this.cancelled && this.run.status !== "failed") {
        this.run.status = "passed";
        this.log(
          "success",
          completionSuccessLog(this.run.plan?.flowId, this.run.plan?.flowName),
          runId,
        );
      }
    } catch (error) {
      if (this.cancelled) {
        this.run.status = "cancelled";
        this.log("warn", "🛑 Test stopped (cancelled).", runId);
      } else {
        this.run.status = "failed";
        this.run.failureExplanation =
          error instanceof Error ? error.message : String(error);
        this.log("error", this.run.failureExplanation, runId);
      }
    } finally {
      this.run.finishedAt = new Date().toISOString();

      const executiveSummary = this.copilot.buildExecutiveSummary(
        this.run,
        this.preflight,
        this.failureAnalyses,
      );
      this.run.executiveSummary = executiveSummary as unknown as Record<string, unknown>;
      this.emit({
        type: "copilot:executive-summary",
        runId: this.run.id,
        report: executiveSummary as unknown as Record<string, unknown>,
      });
      try {
        const reportPath = this.copilot.persistReports(
          this.run,
          this.preflight,
          join(process.cwd(), "reports"),
          this.failureAnalyses,
        );
        this.log("agent", `Executive summary exported: ${reportPath}`, this.run.id);
      } catch {
        /* best-effort */
      }

      const sessionPolicy = this.run.plan?.sessionPolicy ?? "fresh";
      if (sessionPolicy === "fresh") {
        await this.session.disconnect();
      }

      await this.stopRecording();
      // simctl flushes/finalizes the MP4 asynchronously after its process closes.
      // For long runs (full-regression ~90 steps) this can take several seconds.
      // Poll up to 10 seconds so we never miss the file.
      const videoPath = join(this.artifactsRoot, this.run.id, "recording.mp4");
      for (let i = 0; i < 20; i++) {
        if (existsSync(videoPath)) {
          this.run.videoPath = videoPath;
          this.log("agent", `Screen recording saved: ${videoPath}`, this.run.id);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      this.emit({ type: "run:finished", run: this.run });
    }

    return this.run;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async cancelNow(): Promise<void> {
    this.cancelled = true;
    const runId = this.run?.id;
    if (!runId || !this.run) return;

    if (this.run.status === "running" || this.run.status === "healing" || this.run.status === "booting") {
      this.run.status = "cancelled";
      this.emit({ type: "run:status", runId, status: "cancelled" });
      this.log("warn", "🛑 Test stopped (cancelled).", runId);
    }

    await this.session.disconnect().catch(() => undefined);
  }

  private startRecording(videoPath: string, udid?: string): void {
    try {
      if (this.recordingProc) {
        this.recordingProc.kill("SIGINT");
        this.recordingProc = null;
      }
      // Kill any stale simctl recordVideo processes left over from previous runs before starting.
      // "Host recording is already in progress" (EBUSY) prevents new recordings until released.
      execAsync("pkill -SIGINT -f 'simctl io.*recordVideo'").catch(() => undefined);
      setTimeout(() => {
        if (!this.recordingProc) {
          this._spawnRecording(videoPath, udid);
        }
      }, 1500);
    } catch {
      this.recordingProc = null;
    }
  }

  private _spawnRecording(videoPath: string, udid?: string): void {
    try {
      const args = ["simctl", "io", udid ?? "booted", "recordVideo", "--force", videoPath];
      const proc = spawn("xcrun", args, { stdio: ["ignore", "ignore", "pipe"] });
      this.recordingProc = proc;

      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("error", () => { this.recordingProc = null; });
      proc.on("close", (code) => {
        if (this.recordingProc === proc) this.recordingProc = null;
        // Retry once if it exited non-zero and not from our own SIGINT (code 2)
        if (code !== null && code !== 0 && code !== 2) {
          const reason = stderr.slice(0, 120).trim();
          if (reason) console.warn(`[recording] simctl exited ${code}: ${reason}`);
          setTimeout(() => {
            if (!this.recordingProc) this._spawnRecording(videoPath, udid);
          }, 2000);
        }
      });
    } catch {
      this.recordingProc = null;
    }
  }

  private stopRecording(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      // Also kill any orphaned system-level simctl recording (e.g. if recordingProc ref was lost).
      execAsync("pkill -SIGINT -f 'simctl io.*recordVideo'").catch(() => undefined);
      if (!this.recordingProc) { setTimeout(done, 1500); return; }
      const proc = this.recordingProc;
      this.recordingProc = null;
      proc.on("close", done);
      proc.kill("SIGINT");
      // Give simctl up to 12s to finish flushing the MP4 before we force-continue.
      // Long runs (full-regression ~90 steps) produce large files that take time to finalize.
      setTimeout(done, 12000);
    });
  }

  private async ensureAppBuilt(runId: string): Promise<void> {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../scripts/build-operator-app.ts",
    );
    this.log("agent", "Building Toast Operator if needed…", runId);
    await execAsync(`npx tsx "${script}"`, {
      cwd: join(dirname(fileURLToPath(import.meta.url)), "../.."),
      env: process.env,
    });
  }

  private async executeStep(
    step: TestStep,
    actions: FlowActions,
    injectDemoFailure = false,
  ): Promise<void> {
    const handlers: Record<string, () => Promise<void | { healed: boolean; usedSelector: string; healingReason?: string }>> = {
      bootSimulator: () => actions.bootSimulator(),
      launchApp: () => actions.launchApp(),
      ensureLoggedIn: () => actions.ensureLoggedIn(),
      tapAccountTab: () => actions.tapAccountTab(),
      scrollAccountMenuToLogout: () => actions.scrollAccountMenuToLogout(),
      tapLogout: () => actions.tapLogout(),
      tapConfirmLogout: () => actions.tapConfirmLogout(),
      finishLogoutFlow: () => actions.finishLogoutFlow(),
      navigateToInventoryTab: () => actions.navigateToInventoryTab(),
      verifyInventoryHome: () => actions.verifyInventoryHome(),
      selectCountSheet: () => actions.selectCountSheet(),
      selectCountSheetRequired: () => actions.selectCountSheetRequired(),
      selectCountSheetOrCreateFromTemplate: () => actions.selectCountSheetOrCreateFromTemplate(),
      startCounting: () => actions.startCounting(injectDemoFailure),
      openFirstLocation: () => actions.openFirstLocation(),
      backFromCountingToHome: () => actions.backFromCountingToHome(),
      enterCountQuantity: () => actions.enterCountQuantity(),
      submitLocationCount: () => actions.submitLocationCount(),
      submitCountSheet: () => actions.submitCountSheet(),
      validatePostSubmission: () => actions.validatePostSubmission(),
      dismissCycleCountSubmissionSuccess: () => actions.dismissCycleCountSubmissionSuccess(),
      addItemLocation: () => actions.addItemLocation(),
      tapKeepThemBlankButton: () => actions.tapKeepThemBlankButton(),
      addNewItem: () => actions.addNewItem(),
      editItem: () => actions.editItem(),
      editItemReadOnly: () => actions.editItemReadOnly(),
      backFromProductCatalogToHome: () => actions.backFromProductCatalogToHome(),
      openProductCatalog: () => actions.openProductCatalog(),
      verifyProductCatalog: () => actions.verifyProductCatalog(),
      verifyProductCatalogFilters: () => actions.verifyProductCatalogFilters(),
      openProductCatalogFilterSheet: () => actions.openProductCatalogFilterSheet(),
      verifyProductCatalogSortByFilter: () => actions.verifyProductCatalogSortByFilter(),
      verifyProductCatalogCategoryFilter: () => actions.verifyProductCatalogCategoryFilter(),
      verifyProductCatalogVendorFilter: () => actions.verifyProductCatalogVendorFilter(),
      verifyProductCatalogWarningsFilter: () => actions.verifyProductCatalogWarningsFilter(),
      closeProductCatalogFilterSheet: () => actions.closeProductCatalogFilterSheet(),
      openFirstProductDetails: () => actions.openFirstProductDetails(),
      verifyProductInfoSection: () => actions.verifyProductInfoSection(),
      verifyInventorySection: () => actions.verifyInventorySection(),
      verifyOrdersSection: () => actions.verifyOrdersSection(),
      verifyPricingAndCostsSection: () => actions.verifyPricingAndCostsSection(),
      verifyDescriptionSection: () => actions.verifyDescriptionSection(),
      backToProductCatalog: () => actions.backToProductCatalog(),
      tapCatalogViewAll: () => actions.tapCatalogViewAll(),
      applyLowStockFilter: () => actions.applyLowStockFilter(),
      captureFilterCount: () => actions.captureFilterCount(),
      editFirstFilteredProduct: () => actions.editFirstFilteredProduct(),
      verifyFilterCountUpdated: () => actions.verifyFilterCountUpdated(),
      applyOutOfStockFilter: () => actions.applyOutOfStockFilter(),
      verifyOutOfStockFilter: () => actions.verifyOutOfStockFilter(),
      applyNotSellingFilter: () => actions.applyNotSellingFilter(),
      verifyNotSellingFilter: () => actions.verifyNotSellingFilter(),
      clearActiveFilters: () => actions.clearActiveFilters(),
      searchProductByName: () => actions.searchProductByName(),
      editProductInventoryFields: () => actions.editProductInventoryFields(),
      expandVariantProduct: () => actions.expandVariantProduct(),
      verifyVariantExpansion: () => actions.verifyVariantExpansion(),
      tapAddProductButton: () => actions.tapAddProductButton(),
      enterProductName: () => actions.enterProductName(),
      selectProductCategory: () => actions.selectProductCategory(),
      enterProductBasePrice: () => actions.enterProductBasePrice(),
      saveNewProduct: () => actions.saveNewProduct(),
      editProductBasePrice: () => actions.editProductBasePrice(),
      deleteProduct: () => actions.deleteProduct(),
      backFromInvoiceToHome: () => actions.backFromInvoiceToHome(),
      tapManageInvoices: () => actions.tapManageInvoices(),
      openInvoiceManagement: () => actions.openInvoiceManagement(),
      openFirstInvoiceWithChevron: () => actions.openFirstInvoiceWithChevron(),
      finishInvoiceScanView: () => actions.finishInvoiceScanView(),
      verifyInvoiceManagement: () => actions.verifyInvoiceManagement(),
      tapUploadInvoice: () => actions.tapUploadInvoice(),
      acceptCameraPermissionAlert: () => actions.acceptCameraPermissionAlert(),
      switchInvoiceCaptureToManual: () => actions.switchInvoiceCaptureToManual(),
      captureInvoicePhoto: () => actions.captureInvoicePhoto(),
      dismissLowQualityInvoicePopupIfNeeded: () => actions.dismissLowQualityInvoicePopupIfNeeded(),
      finishInvoiceUploadPreview: () => actions.finishInvoiceUploadPreview(),
      tapInvoicePreviewEdit: () => actions.tapInvoicePreviewEdit(),
      tapInvoiceAutoCrop: () => actions.tapInvoiceAutoCrop(),
      tapInvoiceApply: () => actions.tapInvoiceApply(),
      tapInvoiceNext: () => actions.tapInvoiceNext(),
      tapInvoiceSubmit: () => actions.tapInvoiceSubmit(),
      dismissInvoiceSubmissionSuccess: () => actions.dismissInvoiceSubmissionSuccess(),
      verifyLowQualityPopupLandscape: () => actions.verifyLowQualityPopupLandscape(),
      rotateToLandscape: () => actions.rotateToLandscape(),
      rotateToPortrait: () => actions.rotateToPortrait(),
      captureInvoicePhotoOnce: () => actions.captureInvoicePhotoOnce(),
      verifyLowQualityPopupVisible: () => actions.verifyLowQualityPopupVisible(),
      verifyCountingStyles: async () => {
        step.logs.push("Skipped in demo — use full smoke for style toggle");
      },
    };

    const handler = handlers[step.action];
    if (!handler) {
      throw new Error(`Unknown action: ${step.action}`);
    }

    const result = await handler();
    if (result && typeof result === "object" && "healed" in result && result.healed) {
      step.status = "healed";
      const event = this.healer.toHealingEvent(
        step.id,
        step.action,
        {
          selector: result.usedSelector,
          strategy: "demo-self-heal",
          reason: result.healingReason ?? "Self-healed selector",
        },
      );
      this.run!.healingEvents.push(event);
      this.run!.status = "healing";
      this.emit({ type: "run:status", runId: this.run!.id, status: "healing" });
      this.emit({ type: "step:healing", runId: this.run!.id, event });
      this.log("agent", `🔧 Self-healed: ${event.healedSelector}`, this.run!.id, step.id);
      this.run!.status = "running";
      this.emit({ type: "run:status", runId: this.run!.id, status: "running" });
    }
  }

  private log(
    level: LogEntry["level"],
    message: string,
    runId: string,
    stepId?: string,
  ): void {
    const entry: LogEntry = {
      id: uuid(),
      level,
      message,
      timestamp: new Date().toISOString(),
      stepId,
    };
    this.run?.logs.push(entry);
    this.emit({ type: "log", runId, entry });
  }

  private emit(event: AgentEvent): void {
    this.onEvent(event);
  }
}
