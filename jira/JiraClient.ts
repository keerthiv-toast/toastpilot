export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  labels: string[];
  components: string[];
  status: string;
  issueType: string;
  priority: string;
  reporter: string;
  assignee: string;
  storyPoints: number | null;
  rawFields: Record<string, unknown>;
}

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraBugPayload {
  projectKey: string;
  summary: string;
  description: string;
  stepsToReproduce: string[];
  failureDetail: string;
  command: string;
  runId: string;
  featureName: string;
  priority: "Highest" | "High" | "Medium" | "Low" | "Lowest";
  labels: string[];
}

export interface CreatedJiraIssue {
  key: string;
  url: string;
}

function extractTextFromAdf(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content !== "object") return String(content);

  const node = content as Record<string, unknown>;

  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }

  const parts: string[] = [];
  const children = (node.content as unknown[]) ?? [];
  for (const child of children) {
    const text = extractTextFromAdf(child);
    if (text) parts.push(text);
  }

  const blockTypes = new Set([
    "paragraph", "heading", "bulletList", "orderedList",
    "listItem", "blockquote", "codeBlock", "rule", "panel",
  ]);
  const sep = blockTypes.has(String(node.type ?? "")) ? "\n" : " ";
  return parts.join(sep).replace(/ +/g, " ").trim();
}

function parseAcceptanceCriteria(text: string): string {
  if (!text) return "";

  const acHeaderRe = /acceptance criteria[:\s]*/i;
  const idx = text.search(acHeaderRe);
  if (idx !== -1) {
    const after = text.slice(idx).replace(acHeaderRe, "").trim();
    const nextSection = after.search(/\n\s*\n\s*[A-Z#]/);
    return (nextSection !== -1 ? after.slice(0, nextSection) : after).trim();
  }

  const gherkinLines = text
    .split("\n")
    .filter((l) => /^\s*(given|when|then|and|but)\b/i.test(l))
    .map((l) => l.trim());
  if (gherkinLines.length >= 2) return gherkinLines.join("\n");

  return text;
}

export interface JiraAttachScenario {
  title: string;
  description?: string;
  category?: string;
}

export class JiraClient {
  private readonly config: JiraClientConfig;

  constructor(config?: Partial<JiraClientConfig>) {
    this.config = {
      baseUrl: (config?.baseUrl ?? process.env.JIRA_BASE_URL ?? "").replace(/\/$/, ""),
      email: config?.email ?? process.env.JIRA_USER_EMAIL ?? "",
      apiToken: config?.apiToken ?? process.env.JIRA_API_TOKEN ?? "",
    };
  }

  get isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.email && this.config.apiToken);
  }

  private get authHeader(): string {
    const credentials = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64");
    return `Basic ${credentials}`;
  }

  async fetchIssue(ticketKey: string): Promise<JiraIssue> {
    if (!this.isConfigured) {
      throw new Error(
        "Jira is not configured. Set JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN in your .env file.",
      );
    }

    const sanitized = ticketKey.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(sanitized)) {
      throw new Error(
        `Invalid Jira ticket key: "${ticketKey}". Expected format: PROJECT-123 (e.g. SMB-1168).`,
      );
    }

    const url = `${this.config.baseUrl}/rest/api/3/issue/${sanitized}?expand=renderedFields`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new Error(
          `Jira authentication failed (401). Check JIRA_USER_EMAIL and JIRA_API_TOKEN in your .env file.`,
        );
      }
      if (response.status === 403) {
        throw new Error(
          `Jira access denied (403) for ${sanitized}. Ensure your API token has read access to this project.`,
        );
      }
      if (response.status === 404) {
        throw new Error(
          `Jira ticket ${sanitized} not found (404). Check the ticket key and that it exists in your Jira instance.`,
        );
      }
      throw new Error(`Jira API error ${response.status} for ${sanitized}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.parseIssue(sanitized, data);
  }

  async createBug(payload: JiraBugPayload): Promise<CreatedJiraIssue> {
    if (!this.isConfigured) {
      throw new Error(
        "Jira is not configured. Set JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN in your .env file.",
      );
    }

    const projectKey = payload.projectKey.trim().toUpperCase();
    if (!projectKey) {
      throw new Error("JIRA_PROJECT_KEY is not set. Add it to your .env file (e.g. JIRA_PROJECT_KEY=SMB).");
    }

    const stepsBlock = payload.stepsToReproduce.length > 0
      ? payload.stepsToReproduce
          .map((s, i) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `${i + 1}. ${s}` }] }] }))
      : [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "See agent run log." }] }] }];

    const descriptionAdf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Failure Summary" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: payload.failureDetail || "No failure detail available." }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Steps to Reproduce" }],
        },
        {
          type: "bulletList",
          content: stepsBlock,
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Agent Run Details" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: `Command: `, marks: [{ type: "strong" }] },
            { type: "text", text: payload.command },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: `Feature: `, marks: [{ type: "strong" }] },
            { type: "text", text: payload.featureName },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: `Run ID: `, marks: [{ type: "strong" }] },
            { type: "text", text: payload.runId },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: `Detected by: `, marks: [{ type: "strong" }] },
            { type: "text", text: "ToastPilot Autonomous QA Agent" },
          ],
        },
      ],
    };

    const body = {
      fields: {
        project: { key: projectKey },
        summary: payload.summary,
        description: descriptionAdf,
        issuetype: { name: "Bug" },
        priority: { name: payload.priority },
        labels: ["toastpilot-auto", ...payload.labels].filter(
          (l, i, a) => l.trim().length > 0 && a.indexOf(l) === i,
        ),
      },
    };

    const url = `${this.config.baseUrl}/rest/api/3/issue`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        const msgs = [
          ...(parsed.errorMessages ?? []),
          ...Object.values(parsed.errors ?? {}),
        ];
        if (msgs.length) detail = msgs.join("; ");
      } catch { /* use raw text */ }

      if (response.status === 401) throw new Error("Jira authentication failed (401). Check your API token.");
      if (response.status === 403) throw new Error(`Jira permission denied (403) for project ${projectKey}. Ensure your account can create issues.`);
      if (response.status === 400) throw new Error(`Jira rejected the bug payload (400): ${detail}`);
      throw new Error(`Jira API error ${response.status}: ${detail}`);
    }

    const created = (await response.json()) as { id: string; key: string; self: string };
    return {
      key: created.key,
      url: `${this.config.baseUrl}/browse/${created.key}`,
    };
  }

  async attachFile(issueKey: string, filePath: string, fileName: string, mimeType: string): Promise<void> {
    if (!this.isConfigured) throw new Error("Jira is not configured.");

    const { readFileSync } = await import("fs");
    const fileBuffer = readFileSync(filePath);

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("file", blob, fileName);

    const url = `${this.config.baseUrl}/rest/api/3/issue/${issueKey}/attachments`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "X-Atlassian-Token": "no-check",
      },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Failed to attach ${fileName} to ${issueKey} (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  async attachScenariosComment(issueKey: string, scenarios: JiraAttachScenario[]): Promise<void> {
    if (!this.isConfigured) throw new Error("Jira is not configured.");

    const categoryLabel: Record<string, string> = {
      happy_path: "Positive",
      negative: "Negative",
      edge: "Edge",
      role_based: "Role-based",
      permission: "Permission",
    };

    const listItems = scenarios.map((s) => {
      const cat = s.category ? (categoryLabel[s.category] ?? s.category) : null;
      const label = cat ? `[${cat}] ${s.title}` : s.title;
      const children: unknown[] = [{ type: "paragraph", content: [{ type: "text", text: label, marks: [{ type: "strong" }] }] }];
      if (s.description) {
        children.push({ type: "paragraph", content: [{ type: "text", text: s.description }] });
      }
      return { type: "listItem", content: children };
    });

    const body = {
      body: {
        type: "doc",
        version: 1,
        content: [
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "ToastPilot — Generated Test Scenarios" }] },
          { type: "paragraph", content: [{ type: "text", text: `${scenarios.length} scenario${scenarios.length !== 1 ? "s" : ""} generated by ToastPilot Autonomous QA Agent.` }] },
          { type: "bulletList", content: listItems },
        ],
      },
    };

    const url = `${this.config.baseUrl}/rest/api/3/issue/${issueKey}/comment`;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: this.authHeader, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Failed to add scenarios comment to ${issueKey} (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  private parseIssue(key: string, data: Record<string, unknown>): JiraIssue {
    const fields = (data.fields ?? {}) as Record<string, unknown>;

    const descriptionAdf = fields.description;
    const descriptionText = extractTextFromAdf(descriptionAdf);

    const storyPointFields = ["story_points", "customfield_10016", "customfield_10028", "customfield_10014"];
    let storyPoints: number | null = null;
    for (const f of storyPointFields) {
      const v = fields[f];
      if (typeof v === "number") { storyPoints = v; break; }
    }

    const acCustomField = process.env.JIRA_AC_FIELD ?? "customfield_10500";
    const acCustom = extractTextFromAdf(fields[acCustomField]);
    const acceptanceCriteria = acCustom || parseAcceptanceCriteria(descriptionText);

    return {
      key,
      summary: String(fields.summary ?? ""),
      description: descriptionText,
      acceptanceCriteria,
      labels: ((fields.labels as string[] | undefined) ?? []),
      components: ((fields.components as Array<{ name: string }> | undefined) ?? []).map((c) => c.name),
      status: String(((fields.status as Record<string, unknown> | undefined)?.name) ?? ""),
      issueType: String(((fields.issuetype as Record<string, unknown> | undefined)?.name) ?? ""),
      priority: String(((fields.priority as Record<string, unknown> | undefined)?.name) ?? ""),
      reporter: String(
        ((fields.reporter as Record<string, unknown> | undefined)?.displayName) ?? "",
      ),
      assignee: String(
        ((fields.assignee as Record<string, unknown> | undefined)?.displayName) ?? "Unassigned",
      ),
      storyPoints,
      rawFields: fields,
    };
  }
}
