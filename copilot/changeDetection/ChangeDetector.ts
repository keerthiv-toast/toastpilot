import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type {
  FeatureAnalysis,
  GeneratedScenario,
  ImpactedArea,
  PreflightResult,
  RiskLevel,
} from "../types.js";
import { clampConfidence } from "../confidence.js";
import { buildCommandAlignedPreflight } from "../commandPreflight.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "../..");
const REPO_ROOT = join(AGENT_ROOT, "../../..");
const UNIFIED_INVENTORY = "ToastOperatorApp/ToastUnifiedInventory";
const FLOWS_PATH = join(AGENT_ROOT, "knowledge/inventory-flows.json");

const MODULE = "ToastUnifiedInventory";

interface InventoryFlow {
  id: string;
  name: string;
  aliases?: string[];
}

const AREA_PATTERNS: Array<{
  area: string;
  patterns: RegExp[];
  flowIds: string[];
  defaultRisk: RiskLevel;
}> = [
  {
    area: "Cycle Count",
    patterns: [/CycleCount/i, /cycle.?count/i, /counting/i, /CountSheet/i],
    flowIds: ["cycle-count", "cycle-count-smoke", "add-new-item", "edit-item", "add-item-location"],
    defaultRisk: "High",
  },
  {
    area: "Product Catalog",
    patterns: [/ProductCatalog/i, /product.?catalog/i],
    flowIds: ["product-catalog"],
    defaultRisk: "Medium",
  },
  {
    area: "Invoice Scanning",
    patterns: [/InvoiceScanning/i, /invoice/i, /scanbot/i, /UploadInvoice/i],
    flowIds: ["upload-invoice", "invoice-scanning"],
    defaultRisk: "High",
  },
  {
    area: "Inventory Home",
    patterns: [/InventoryHome/i, /UnifiedInventory/i, /InventoryTab/i],
    flowIds: ["minimal-smoke", "login-only"],
    defaultRisk: "Medium",
  },
  {
    area: "Account / Logout",
    patterns: [/logout/i, /AccountTab/i, /sign.?out/i],
    flowIds: ["logout-only"],
    defaultRisk: "Medium",
  },
  {
    area: "Operator Login & Auth",
    patterns: [/login/i, /sign.?in/i, /auth/i],
    flowIds: ["login-only"],
    defaultRisk: "Medium",
  },
  {
    area: "Fulfillment",
    patterns: [/Fulfillment/i],
    flowIds: [],
    defaultRisk: "Low",
  },
  {
    area: "Inventory Management",
    patterns: [/InventoryManagement/i],
    flowIds: [],
    defaultRisk: "Low",
  },
];

export interface ChangeDetectionInput {
  gitBase?: string;
  sinceRef?: string;
  /** When set (e.g. merge-test CI), skip git and use this file list. */
  changedFilesOverride?: string[];
  prBody?: string;
  jiraTicket?: string;
  commitMessage?: string;
  command?: string;
  jiraContext?: import("../../agent/types.js").JiraContext;
}

export class ChangeDetector {
  /** Leadership preflight: git diff → impact → scenarios → recommended agent command. */
  preflight(input: ChangeDetectionInput = {}): PreflightResult {
    const command = input.command?.trim();

    if (command) {
      const aligned = buildCommandAlignedPreflight(command, input.jiraContext);
      if (aligned) return aligned;
    }

    const gitBase = input.gitBase ?? process.env.COPILOT_GIT_BASE ?? "main";
    const changedFiles =
      input.changedFilesOverride ?? this.gitChangedFiles(gitBase, input.sinceRef);

    const impactedAreas = this.mapImpactedAreas(changedFiles, input);
    const scenarios = this.generateScenarios(impactedAreas, input);
    const recommendedFlowIds = this.rankFlowIds(impactedAreas, scenarios);
    const recommendedCommand = command ?? this.buildRecommendedCommand(recommendedFlowIds);
    const risk = this.maxRisk(impactedAreas);
    const featureName = this.inferFeatureName(impactedAreas, input);

    const featureAnalysis: FeatureAnalysis = {
      id: `analysis-${Date.now()}`,
      analyzedAt: new Date().toISOString(),
      featureName,
      impactedModule: MODULE,
      risk,
      changedFiles,
      impactedAreas,
      newWorkflows: scenarios.map((s) => s.title),
      prSummary: input.prBody?.slice(0, 2000),
      confidenceScore: this.computeFeatureConfidence(input, changedFiles, impactedAreas, scenarios),
    };

    return {
      featureAnalysis,
      scenarios,
      recommendedFlowIds,
      recommendedCommand,
    };
  }

  /** Alias for HTTP handlers and legacy callers. */
  analyze(input: ChangeDetectionInput = {}): PreflightResult {
    return this.preflight(input);
  }

  buildRecommendedCommand(flowIds: string[]): string {
    const flows = this.loadFlows();
    if (flowIds.length === 0) {
      return this.phraseForFlow(flows.find((f) => f.id === "minimal-smoke"), "minimal-smoke");
    }

    const phrases = flowIds.map((id) => {
      const flow = flows.find((f) => f.id === id);
      return this.phraseForFlow(flow, id);
    });

    return [...new Set(phrases)].join(" and ");
  }

  private phraseForFlow(flow: InventoryFlow | undefined, flowId: string): string {
    if (!flow) return flowId.replace(/-/g, " ");

    const regressionAlias = flow.aliases?.find((a) =>
      /full regression|entire regression/i.test(a),
    );
    if (regressionAlias) {
      return regressionAlias.replace(/^test\s+/i, "").trim();
    }

    const testAlias = flow.aliases?.find((a) => /^test\s+/i.test(a));
    if (testAlias) return testAlias.replace(/^test\s+/i, "").trim();

    const plain = flow.aliases?.[0];
    if (plain) return plain.replace(/^test\s+/i, "").trim();

    return flow.name.toLowerCase();
  }

  private loadFlows(): InventoryFlow[] {
    try {
      const raw = JSON.parse(readFileSync(FLOWS_PATH, "utf-8")) as { flows?: InventoryFlow[] };
      return raw.flows ?? [];
    } catch {
      return [];
    }
  }

  private gitChangedFiles(base: string, sinceRef?: string): string[] {
    const range = sinceRef?.trim() ? `${sinceRef.trim()}..HEAD` : `${base}...HEAD`;
    const result = this.runGit(["diff", "--name-only", range, "--", UNIFIED_INVENTORY]);
    if (result !== null) return result;

    const fallback = this.runGit(["diff", "--name-only", "HEAD", "--", UNIFIED_INVENTORY]);
    return fallback ?? [];
  }

  private runGit(args: string[]): string[] | null {
    const result = spawnSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) return null;
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private mapImpactedAreas(files: string[], input: ChangeDetectionInput): ImpactedArea[] {
    const text = [files.join("\n"), input.prBody ?? "", input.commitMessage ?? "", input.command ?? ""].join("\n");
    const hits: ImpactedArea[] = [];

    for (const def of AREA_PATTERNS) {
      if (def.patterns.some((p) => p.test(text))) {
        hits.push({
          area: def.area,
          module: MODULE,
          risk: def.defaultRisk,
          reason: `Matched changes or description for ${def.area}`,
          suggestedFlowIds: def.flowIds,
        });
      }
    }

    if (hits.length === 0 && files.length > 0) {
      hits.push({
        area: "Inventory Home",
        module: MODULE,
        risk: "Medium",
        reason: "Unified Inventory files changed (area inferred from path)",
        suggestedFlowIds: ["minimal-smoke"],
      });
    }

    return hits;
  }

  private generateScenarios(
    areas: ImpactedArea[],
    input: ChangeDetectionInput,
  ): GeneratedScenario[] {
    const scenarios: GeneratedScenario[] = [];
    const pr = `${input.prBody ?? ""} ${input.command ?? ""}`.toLowerCase();

    if (pr.includes("bulk approval") || pr.includes("approve count")) {
      scenarios.push(
        { id: "s1", title: "Open Cycle Count", category: "happy_path", mappedFlowId: "cycle-count", mappedAutomation: "startCounting.ts", priority: 1 },
        { id: "s2", title: "Select multiple items", category: "happy_path", mappedFlowId: "cycle-count-smoke", priority: 2 },
        { id: "s3", title: "Approve counts", category: "happy_path", mappedFlowId: "cycle-count", priority: 3 },
        { id: "s4", title: "Validate approval status", category: "happy_path", mappedFlowId: "cycle-count", priority: 4 },
        { id: "s5", title: "Validate inventory updates", category: "edge", mappedFlowId: "cycle-count-smoke", priority: 5 },
        { id: "s6", title: "Manager role approval flow", category: "role_based", priority: 6 },
        { id: "s7", title: "Permission validation", category: "permission", priority: 7 },
        { id: "s8", title: "Retry after network failure", category: "negative", priority: 8 },
      );
    }

    for (const area of areas) {
      if (area.area === "Cycle Count") {
        scenarios.push(
          { id: "cc-1", title: "Run full cycle count regression", category: "happy_path", mappedFlowId: "cycle-count-smoke", mappedAutomation: "Smoke.spec.ts", priority: 1 },
          { id: "cc-2", title: "Add and edit item on count sheet", category: "happy_path", mappedFlowId: "edit-item", mappedAutomation: "addItem.ts / editItem.ts", priority: 2 },
        );
      }
      if (area.area === "Invoice Scanning") {
        scenarios.push(
          { id: "inv-1", title: "Upload invoice capture flow", category: "happy_path", mappedFlowId: "upload-invoice", priority: 1 },
          { id: "inv-2", title: "Manage invoices list", category: "happy_path", mappedFlowId: "invoice-scanning", priority: 2 },
        );
      }
      if (area.area === "Product Catalog") {
        scenarios.push(
          { id: "pc-1", title: "Open product catalog", category: "happy_path", mappedFlowId: "product-catalog", priority: 1 },
        );
      }
      if (area.area === "Account / Logout") {
        scenarios.push(
          { id: "lo-1", title: "Logout from account tab", category: "happy_path", mappedFlowId: "logout-only", priority: 3 },
        );
      }
      if (area.area === "Operator Login & Auth") {
        scenarios.push(
          { id: "li-1", title: "Sign in with QA account", category: "happy_path", mappedFlowId: "login-only", priority: 1 },
          { id: "li-2", title: "Verify Inventory home after login", category: "happy_path", mappedFlowId: "login-only", priority: 2 },
        );
      }
    }

    if (scenarios.length === 0) {
      scenarios.push({
        id: "default-1",
        title: "Unified Inventory minimal smoke",
        category: "happy_path",
        mappedFlowId: "minimal-smoke",
        mappedAutomation: "Smoke.spec.ts",
        priority: 1,
      });
    }

    return scenarios.sort((a, b) => a.priority - b.priority);
  }

  private rankFlowIds(areas: ImpactedArea[], scenarios: GeneratedScenario[]): string[] {
    const fromAreas = areas.flatMap((a) => a.suggestedFlowIds);
    const fromScenarios = scenarios
      .map((s) => s.mappedFlowId)
      .filter((id): id is string => Boolean(id));
    const merged = [...fromScenarios, ...fromAreas];
    return [...new Set(merged)];
  }

  private inferFeatureName(areas: ImpactedArea[], input: ChangeDetectionInput): string {
    if (input.jiraTicket) return input.jiraTicket;
    if (areas.length > 0) return areas.map((a) => a.area).join(" + ");
    return "ToastUnifiedInventory change set";
  }

  private maxRisk(areas: ImpactedArea[]): RiskLevel {
    if (areas.some((a) => a.risk === "High")) return "High";
    if (areas.some((a) => a.risk === "Medium")) return "Medium";
    return "Low";
  }

  /** Score 58–96 from real signals (git diff, PR text, areas, scenarios) — not a flat 72%. */
  private computeFeatureConfidence(
    input: ChangeDetectionInput,
    changedFiles: string[],
    impactedAreas: ImpactedArea[],
    scenarios: GeneratedScenario[],
  ): number {
    let score = 62;

    score += Math.min(18, changedFiles.length * 3);
    if (input.prBody?.trim()) score += 14;
    if (input.jiraTicket?.trim()) score += 10;
    if (input.commitMessage?.trim()) score += 6;
    if (input.command?.trim()) score += 8;
    score += impactedAreas.length * 5;
    score += Math.min(12, scenarios.filter((s) => s.mappedFlowId).length * 2);

    const highRisk = impactedAreas.filter((a) => a.risk === "High").length;
    score += highRisk * 3;

    if (process.env.OPENAI_API_KEY?.trim()) score += 4;

    return clampConfidence(score);
  }
}
