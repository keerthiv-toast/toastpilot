import type { JiraIssue } from "./JiraClient.js";
import type { OpenAIClient } from "../agent/core/OpenAIClient.js";
import type { JiraContext } from "../agent/types.js";

const FLOW_KEYWORDS: Array<{ flowId: string; command: string; keywords: RegExp[] }> = [
  {
    flowId: "pc-filter-refresh",
    command: "Test PC filters refresh filter counts",
    keywords: [
      /filter.count.*(refresh|instant|update|real.?time)/i,
      /refresh.filter.count/i,
      /filter.*refresh.*product/i,
      /pc.filter/i,
      /filter.count.*after.*(product|update|edit)/i,
      /instant.*filter/i,
    ],
  },
  {
    flowId: "product-catalog-regression",
    command: "Test Product Catalog entire flow",
    keywords: [/product.catalog.*(full|entire|regression|e2e|all)/i, /(full|entire|regression).product.catalog/i],
  },
  {
    flowId: "product-catalog-add-edit-delete",
    command: "Test Product Catalog add edit delete",
    keywords: [/product.catalog.*(add|creat|edit|delet)/i, /(add|creat|edit|delet).*(product|catalog)/i],
  },
  {
    flowId: "product-catalog-filters",
    command: "Test Product Catalog filters",
    keywords: [/product.catalog.*(filter|sort)/i, /(filter|sort).*(product|catalog)/i],
  },
  {
    flowId: "product-catalog-details",
    command: "Test Product Catalog details",
    keywords: [/product.catalog.*(detail|view)/i, /(detail|view).*(product|catalog)/i],
  },
  {
    flowId: "product-catalog",
    command: "Test Product Catalog",
    keywords: [/product.?catalog/i],
  },
  {
    flowId: "cycle-count-smoke",
    command: "Test Cycle Count full regression",
    keywords: [/cycle.count.*(full|regression|all|entire)/i, /(full|regression).cycle.count/i],
  },
  {
    flowId: "cycle-count",
    command: "Test Cycle Count inventory flow",
    keywords: [/cycle.?count/i, /count.?sheet/i, /count.?unit/i, /unit.?selector/i, /unit.?label/i, /unit.?display/i, /count.?selector/i],
  },
  {
    flowId: "edit-item",
    command: "Test edit item flow",
    keywords: [/edit.*(item|inventory|quantity)/i, /(item|inventory).edit/i],
  },
  {
    flowId: "add-new-item",
    command: "Test add new item flow",
    keywords: [/add.*(new.)?item/i, /new.item/i],
  },
  {
    flowId: "add-item-location",
    command: "Test add item location flow",
    keywords: [/(add|new).*(item.)?location/i, /location.*(add|creat)/i],
  },
  {
    flowId: "upload-invoice",
    command: "Test upload invoice flow",
    keywords: [/upload.?invoice/i, /add.?invoice/i, /invoice.upload/i],
  },
  {
    flowId: "invoice-landscape-popup",
    command: "Test invoice landscape popup",
    keywords: [
      /invoice.*landscape/i,
      /landscape.*invoice/i,
      /low.image.quality/i,
      /image.quality.*pop.?up/i,
      /landscape.mode.*invoice/i,
      /landscape.mode.*low/i,
      /invoice.*orientation/i,
      /handle.landscape/i,
    ],
  },
  {
    flowId: "invoice-scanning-regression",
    command: "Test Invoice Scanning full regression",
    keywords: [
      /invoice.*(full|entire|regression|e2e|all)/i,
      /(full|entire|regression).invoice/i,
    ],
  },
  {
    flowId: "invoice-scanning",
    command: "Test invoice scanning flow",
    keywords: [
      /manage.?invoice/i,
      /invoice.scan/i,
      /invoice.management/i,
    ],
  },
  {
    flowId: "logout-only",
    command: "Test logout flow",
    keywords: [/log.?out/i, /sign.?out/i],
  },
  {
    flowId: "login-only",
    command: "Test login flow",
    keywords: [/log.?in/i, /sign.?in/i, /authenticat/i],
  },
  {
    flowId: "post-submission-ui",
    command: "Test post submission UI",
    keywords: [/post.submission/i, /success.ui/i, /after.submit/i],
  },
  {
    flowId: "minimal-smoke",
    command: "Run inventory smoke test",
    keywords: [/smoke.?test/i, /sanity/i, /inventory.home/i],
  },
];

interface SynthesisResult {
  command: string;
  flowId: string;
  rationale: string;
  suggestedFlowIds: string[];
  acceptanceCriteria: string[];
}

function scoreText(text: string): { flowId: string; command: string; score: number } | null {
  let best: { flowId: string; command: string; score: number } | null = null;
  for (const entry of FLOW_KEYWORDS) {
    const matches = entry.keywords.filter((re) => re.test(text)).length;
    if (matches > 0) {
      const score = matches * entry.keywords.length;
      if (!best || score > best.score) {
        best = { flowId: entry.flowId, command: entry.command, score };
      }
    }
  }
  return best;
}

function extractAcLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.)\]]+\s*/, "").trim())
    .filter((l) => l.length > 8 && l.length < 250);
}

function buildCorpus(issue: JiraIssue): string {
  return [
    issue.summary,
    issue.summary,
    issue.acceptanceCriteria,
    issue.description,
    issue.labels.join(" "),
    issue.components.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

export class JiraPlanSynthesizer {
  constructor(private readonly openai: OpenAIClient) {}

  async synthesize(issue: JiraIssue): Promise<SynthesisResult> {
    const corpus = buildCorpus(issue);
    const acLines = extractAcLines(issue.acceptanceCriteria || issue.description);

    const deterministic = scoreText(corpus);
    if (deterministic) {
      return this.buildResult(deterministic.command, deterministic.flowId, acLines, issue,
        `Matched flow "${deterministic.flowId}" from Jira ticket keywords.`);
    }

    if (this.openai.isAvailable) {
      try {
        const aiResult = await this.openai.synthesizeCommandFromJira(issue);
        if (aiResult) {
          const match = scoreText(aiResult.command) ?? { flowId: "minimal-smoke", command: aiResult.command, score: 0 };
          return this.buildResult(aiResult.command, match.flowId, acLines, issue, aiResult.rationale);
        }
      } catch {
        /* fall through to fallback */
      }
    }

    return this.buildResult(
      "Run inventory smoke test",
      "minimal-smoke",
      acLines,
      issue,
      "No specific flow keywords found in the ticket. Running minimal smoke test.",
    );
  }

  private buildResult(
    command: string,
    flowId: string,
    acLines: string[],
    issue: JiraIssue,
    rationale: string,
  ): SynthesisResult {
    const relatedFlows: Record<string, string[]> = {
      "product-catalog-regression": [
        "product-catalog", "product-catalog-filters",
        "product-catalog-details", "product-catalog-add-edit-delete",
      ],
      "pc-filter-refresh": ["product-catalog", "product-catalog-filters"],
      "cycle-count-smoke": ["cycle-count", "edit-item", "add-new-item", "add-item-location"],
      "invoice-scanning-regression": ["upload-invoice", "invoice-scanning", "invoice-landscape-popup"],
    };
    const suggestedFlowIds = [flowId, ...(relatedFlows[flowId] ?? [])];

    return { command, flowId, rationale, suggestedFlowIds, acceptanceCriteria: acLines };
  }
}

export function buildJiraContext(
  issue: JiraIssue,
  synthesis: SynthesisResult,
): JiraContext {
  return {
    ticketKey: issue.key,
    summary: issue.summary,
    description: issue.description,
    acceptanceCriteria: synthesis.acceptanceCriteria,
    flowId: synthesis.flowId,
    suggestedFlowIds: synthesis.suggestedFlowIds,
    rationale: synthesis.rationale,
    labels: issue.labels,
    components: issue.components,
    status: issue.status,
    issueType: issue.issueType,
    priority: issue.priority,
  };
}
