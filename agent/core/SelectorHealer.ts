import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { HealingEvent } from "../types.js";
import { v4 as uuid } from "uuid";
import { resolveLocator, findLocators } from "../executor/RepoLocatorScanner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(
  readFileSync(join(__dirname, "../../knowledge/accessibility-registry.json"), "utf-8"),
) as {
  flows: { cycleCount: { screens: Record<string, { identifiers: string[]; dynamicPatterns?: string[] }> } };
  healingStrategies: { id: string; priority: number }[];
};

export interface HealResult {
  selector: string;
  strategy: string;
  reason: string;
}

/** Self-healing selector resolution for XCUITest / Appium */
export class SelectorHealer {
  private readonly knownIds: Set<string>;

  constructor() {
    this.knownIds = new Set<string>();
    const screens = registry.flows.cycleCount.screens;
    for (const screen of Object.values(screens)) {
      for (const id of screen.identifiers ?? []) {
        this.knownIds.add(id);
      }
    }
  }

  /** Attempt to heal a failed selector using registry + fuzzy strategies */
  async heal(
    failedSelector: string,
    pageSource?: string,
    context?: { stepId?: string; action?: string },
  ): Promise<HealResult | null> {
    const candidates = this.buildCandidates(failedSelector, context?.action);

    for (const candidate of candidates) {
      if (pageSource && !this.pageSourceMentions(pageSource, candidate.selector)) {
        continue;
      }
      return candidate;
    }

    if (pageSource) {
      const fromSource = this.extractFromPageSource(failedSelector, pageSource);
      if (fromSource) {
        return fromSource;
      }
    }

    // Last resort: search the Swift repo for any accessibility ID that resembles
    // the failed selector and exists in the current page source.
    const repoHealed = this.healFromRepo(failedSelector, pageSource, context?.action);
    if (repoHealed) return repoHealed;

    return null;
  }

  /** Searches the ToastUnifiedInventory Swift sources for a matching accessibility ID */
  private healFromRepo(
    failedSelector: string,
    pageSource?: string,
    action?: string,
  ): HealResult | null {
    const id = this.extractIdentifier(failedSelector);

    // 1. Try exact lookup first (handles renames — e.g. old name still used in test)
    const exact = resolveLocator(id);
    if (exact && exact !== failedSelector) {
      if (!pageSource || this.pageSourceMentions(pageSource, exact)) {
        return {
          selector: exact,
          strategy: "repo-exact",
          reason: `Repo scan: exact match for "${id}" in Swift sources`,
        };
      }
    }

    // 2. Fuzzy search: try the action name and the id words as query
    const query = action ? `${action} ${id}` : id;
    const candidates = findLocators(query, 5);
    for (const candidate of candidates) {
      if (!pageSource || this.pageSourceMentions(pageSource, candidate.selector)) {
        return {
          selector: candidate.selector,
          strategy: "repo-fuzzy",
          reason: `Repo scan: fuzzy match "${candidate.id}" for failed selector "${id}" (source: ${candidate.source})`,
        };
      }
    }

    return null;
  }

  toHealingEvent(
    stepId: string,
    original: string,
    result: HealResult,
    aiReason?: string,
  ): HealingEvent {
    return {
      id: uuid(),
      stepId,
      originalSelector: original,
      healedSelector: result.selector,
      strategy: result.strategy,
      timestamp: new Date().toISOString(),
      aiReason: aiReason ?? result.reason,
    };
  }

  private buildCandidates(failed: string, action?: string): HealResult[] {
    const out: HealResult[] = [];
    const id = this.extractIdentifier(failed);

    // Demo injection: wrong selector on purpose
    if (id === "StartCountingButton_WRONG_DEMO") {
      out.push({
        selector: "~StartCountingButton",
        strategy: "accessibility-id",
        reason: "Demo failure injected — healed to canonical StartCountingButton from registry",
      });
    }

    // Known typo / legacy automation mismatch
    if (id.includes("CountSheetNameView") && action === "startCounting") {
      out.push({
        selector: "~StartCountingButton",
        strategy: "accessibility-id",
        reason: "Legacy smoke test targeted CountSheetNameView for start button; healed to StartCountingButton",
      });
    }

    if (this.knownIds.has(id)) {
      out.push({
        selector: `~${id}`,
        strategy: "accessibility-id",
        reason: `Registry confirms identifier ${id}`,
      });
    }

    // Prefix healing for dynamic IDs
    const prefixMatch = [...this.knownIds].find(
      (known) => id.startsWith(known.replace("{id}", "")) || known.replace("{id}", "").startsWith(id.split("_")[0] ?? ""),
    );
    if (prefixMatch && prefixMatch.includes("{id}")) {
      const prefix = prefixMatch.replace("{id}", "");
      out.push({
        selector: `-ios predicate string:name BEGINSWITH "${prefix}"`,
        strategy: "partial-id-prefix",
        reason: `Dynamic pattern ${prefixMatch}`,
      });
    }

    const actionDefaults: Record<string, string[]> = {
      startCounting: ["StartCountingButton", "CountSheetNameView"],
      selectCountSheet: ["CountSheetNameView", "CountListName"],
      submitLocationCount: ["submit_button"],
      validatePostSubmission: ["successCheckmark", "thankYouTitle"],
      navigateToInventoryTab: ["Inventory"],
    };

    for (const fallbackId of actionDefaults[action ?? ""] ?? []) {
      out.push({
        selector: `~${fallbackId}`,
        strategy: "action-default",
        reason: `Fallback for action ${action}`,
      });
    }

    return out;
  }

  private extractFromPageSource(failed: string, pageSource: string): HealResult | null {
    const id = this.extractIdentifier(failed);
    const nameRegex = /name="([^"]+)"/g;
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = nameRegex.exec(pageSource)) !== null) {
      names.add(m[1]);
    }

    const scored = [...names]
      .map((name) => ({
        name,
        score: this.similarity(id.toLowerCase(), name.toLowerCase()),
      }))
      .filter((x) => x.score > 0.45)
      .sort((a, b) => b.score - a.score);

    if (scored[0]) {
      return {
        selector: `~${scored[0].name}`,
        strategy: "fuzzy-page-source",
        reason: `Fuzzy matched "${scored[0].name}" (score ${scored[0].score.toFixed(2)})`,
      };
    }
    return null;
  }

  private pageSourceMentions(pageSource: string, selector: string): boolean {
    const id = selector.replace("~", "").replace(/^.*name="/, "").replace(/".*$/, "");
    return pageSource.includes(`name="${id}"`) || pageSource.includes(id);
  }

  private extractIdentifier(selector: string): string {
    if (selector.startsWith("~")) return selector.slice(1);
    const nameMatch = selector.match(/@name="([^"]+)"/);
    return nameMatch?.[1] ?? selector;
  }

  private similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (b.includes(a) || a.includes(b)) return 0.8;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    const editDist = this.levenshtein(a, b);
    return (longer.length - editDist) / longer.length;
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] =
          b[i - 1] === a[j - 1]
            ? matrix[i - 1][j - 1]
            : Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
      }
    }
    return matrix[b.length][a.length];
  }
}
