import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "..");
const REPO_ROOT = join(AGENT_ROOT, "../../..");
const UNIFIED_INVENTORY = "ToastOperatorApp/ToastUnifiedInventory";

export interface MergeTestContext {
  /** Git range used for the diff (e.g. `abc123..def456`). */
  diffRange: string;
  sinceLabel: string;
  headSha: string;
  headShort: string;
  commitMessage: string;
  jiraTicket?: string;
  changedFiles: string[];
  hasInventoryChanges: boolean;
}

export interface MergeDetectionOptions {
  /** Compare against this ref (default: auto-detect merge or main~1). */
  sinceRef?: string;
  /** Branch name for fallback when since is not set (default: main). */
  gitBase?: string;
  /** Explicit before SHA (CI: Jenkins GIT_PREVIOUS_COMMIT). */
  beforeSha?: string;
  /** Explicit after SHA (CI: default HEAD). */
  afterSha?: string;
}

function git(cmd: string): string {
  return execSync(cmd, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitTry(cmd: string): string | null {
  try {
    return git(cmd);
  } catch {
    return null;
  }
}

function isMergeCommit(): boolean {
  return gitTry("git rev-parse --verify HEAD^2") !== null;
}

function resolveBaseRef(preferred: string): string {
  if (gitTry(`git rev-parse --verify ${preferred}`)) return preferred;
  if (preferred !== "origin/main" && gitTry("git rev-parse --verify origin/main")) {
    return "origin/main";
  }
  return "HEAD~1";
}

function resolveDiffRange(opts: MergeDetectionOptions): { range: string; sinceLabel: string } {
  const before =
    opts.beforeSha?.trim() ??
    process.env.COPILOT_BEFORE_SHA?.trim() ??
    process.env.GIT_PREVIOUS_COMMIT?.trim();
  const after =
    opts.afterSha?.trim() ??
    process.env.COPILOT_AFTER_SHA?.trim() ??
    "HEAD";

  if (before && after) {
    return { range: `${before}..${after}`, sinceLabel: before.slice(0, 12) };
  }

  if (opts.sinceRef?.trim()) {
    const since = opts.sinceRef.trim();
    return { range: `${since}..HEAD`, sinceLabel: since };
  }

  const envSince = process.env.COPILOT_SINCE_REF?.trim();
  if (envSince) {
    return { range: `${envSince}..HEAD`, sinceLabel: envSince };
  }

  if (isMergeCommit()) {
    return { range: "HEAD^1..HEAD", sinceLabel: "HEAD^1 (merge commit)" };
  }

  const base = resolveBaseRef(opts.gitBase ?? process.env.COPILOT_GIT_BASE ?? "main");
  return { range: `${base}~1..HEAD`, sinceLabel: `${base}~1` };
}

function listInventoryFiles(diffRange: string): string[] {
  const out = gitTry(`git diff --name-only ${diffRange} -- ${UNIFIED_INVENTORY}`);
  if (out === null) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function extractJiraTicket(text: string): string | undefined {
  const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match?.[1];
}

/** Detect Unified Inventory file changes for post-merge CI testing. */
export function getMergeTestContext(opts: MergeDetectionOptions = {}): MergeTestContext {
  const { range, sinceLabel } = resolveDiffRange(opts);
  const changedFiles = listInventoryFiles(range);
  const commitMessage = git("git log -1 --pretty=%B HEAD");
  const headSha = git("git rev-parse HEAD");
  const headShort = git("git rev-parse --short HEAD");

  return {
    diffRange: range,
    sinceLabel,
    headSha,
    headShort: headShort,
    commitMessage,
    jiraTicket:
      process.env.COPILOT_JIRA_TICKET?.trim() ??
      extractJiraTicket(commitMessage) ??
      extractJiraTicket(process.env.COPILOT_PR_BODY ?? ""),
    changedFiles,
    hasInventoryChanges: changedFiles.length > 0,
  };
}
