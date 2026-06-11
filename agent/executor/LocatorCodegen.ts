/**
 * LocatorCodegen — generates / updates generated-locators.ts from Swift source,
 * and auto-promotes new static locators into FlowActions.ts.
 *
 * Reads .accessibilityIdentifier("...") calls in changed (or all) Swift files
 * under ToastUnifiedInventory/Sources, then:
 *   1. Writes/merges all IDs into agent/executor/generated-locators.ts
 *   2. Inserts new static IDs directly into the L map in FlowActions.ts
 *      (dynamic IDs get both a BEGINSWITH predicate and indexed XPath variants)
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_FILE = join(__dirname, "generated-locators.ts");
const FLOW_ACTIONS_FILE = join(__dirname, "FlowActions.ts");
// Resolve Swift source root: env var override → repo-relative default
const SWIFT_ROOT =
  process.env.IOS_SWIFT_SOURCE_ROOT ??
  join(__dirname, "../../../../../ToastUnifiedInventory/Sources");

// Marker comment written into FlowActions.ts so we know where auto-promoted
// locators start and can update them on subsequent runs without duplicating.
const PROMOTED_BLOCK_START = "  // ── auto-promoted by LocatorCodegen ──";
const PROMOTED_BLOCK_END = "  // ── end auto-promoted ──";

export interface GeneratedLocator {
  id: string;
  /** `~id` for simple names, predicate string for names containing spaces/hyphens */
  selector: string;
  /** Swift source file path (relative to ToastUnifiedInventory/) */
  sourceFile: string;
  /** True if this ID was not present in the previous generated file */
  isNew: boolean;
}

export interface CodegenResult {
  added: GeneratedLocator[];
  unchanged: number;
  totalWritten: number;
  outputPath: string;
  promoted: number;
  promotionSkipped: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawLocator {
  id: string;
  sourceFile: string;
}

function grepSwiftFiles(swiftFiles: string[] | null): RawLocator[] {
  // If a specific list is given, grep only those; otherwise grep the whole Sources tree.
  const target =
    swiftFiles && swiftFiles.length > 0
      ? swiftFiles.map((f) => `"${f}"`).join(" ")
      : `"${SWIFT_ROOT}"`;

  const flag = swiftFiles && swiftFiles.length > 0 ? "" : "-r";

  let raw: string;
  try {
    raw = execSync(
      `grep -n ${flag} --include="*.swift" 'accessibilityIdentifier' ${target}`,
      { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e: unknown) {
    // exit code 1 = no matches (valid empty result)
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }

  const results: RawLocator[] = [];
  const seen = new Set<string>();

  for (const line of raw.split("\n")) {
    const match = line.match(/^([^:]+):\d+:.*accessibilityIdentifier\s*\(\s*"([^"]+)"/);
    if (!match) continue;
    const [, filePath, id] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({ id, sourceFile: filePath });
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}

function makeSelector(id: string): string {
  // Dynamic IDs (Swift interpolation) — emit a prefix predicate for the static part
  if (id.includes("\\(")) {
    const staticPrefix = id.split("\\(")[0];
    if (staticPrefix) {
      return `-ios predicate string:name BEGINSWITH "${staticPrefix}"`;
    }
    return `// dynamic: ${id}`;
  }
  // Names with spaces or hyphens can't use the ~ shorthand reliably.
  // Use bare double-quotes here — escapeForTsString will add exactly one level
  // of escaping when writing the value into the generated TS file.
  if (/[\s-]/.test(id)) {
    return `-ios predicate string:name == "${id}"`;
  }
  return `~${id}`;
}

/** Escape a selector value so it is safe inside a TypeScript double-quoted string literal. */
function escapeForTsString(s: string): string {
  // Only escape backslashes and double-quotes — one level, applied once.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readExistingIds(): Set<string> {
  if (!existsSync(GENERATED_FILE)) return new Set();
  const content = readFileSync(GENERATED_FILE, "utf-8");
  const ids = new Set<string>();
  for (const m of content.matchAll(/\/\/\s*id:\s*([a-zA-Z0-9_]+)/g)) {
    ids.add(m[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Module-grouping — infer a logical group name from the Swift file path
// e.g. ".../ProductCatalog/Presentation/Views/ProductCatalogPreviewView.swift"
//      → "ProductCatalog"
// ---------------------------------------------------------------------------
function inferGroup(filePath: string): string {
  const parts = filePath.split("/");
  // Walk from deepest to find a recognizable module folder name
  const moduleKeywords = [
    "ProductCatalog", "CycleCount", "Invoice", "Location", "Settings",
    "Shared", "Home", "Count", "Inventory",
  ];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    for (const kw of moduleKeywords) {
      if (p.includes(kw)) return kw;
    }
  }
  // Fallback: parent directory of the file
  return parts[parts.length - 2] ?? "Misc";
}

// ---------------------------------------------------------------------------
// File renderer
// ---------------------------------------------------------------------------
function renderFile(
  locators: Array<RawLocator & { isNew: boolean }>,
  timestamp: string,
): string {
  // Deduplicate camelCase keys before grouping
  const dedupedLocators = deduplicateKeys(locators);

  // Group by module
  const groups = new Map<string, Array<RawLocator & { isNew: boolean; key: string }>>();
  for (const loc of dedupedLocators) {
    const g = inferGroup(loc.sourceFile);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(loc);
  }

  const UNIFIED_INVENTORY_ROOT =
    process.env.UNIFIED_INVENTORY_ROOT ??
    join(__dirname, "../../../../../ToastUnifiedInventory");

  let out = `// AUTO-GENERATED by LocatorCodegen — do NOT edit by hand.
// Re-run: npm run locators:generate
// Last updated: ${timestamp}
//
// Each entry is sourced from a Swift .accessibilityIdentifier("...") call.
// New entries (🆕) were added in the most recent codegen run.
// Review new entries and move intentional ones into FlowActions.ts when needed.
//
// Usage:
//   import { GL } from "./generated-locators.js";
//   await session.waitForDisplayed(GL.productCatalogHeader);

export const GL = {
`;

  for (const [group, entries] of [...groups.entries()].sort()) {
    out += `\n  // ── ${group} ──────────────────────────────────────────────\n`;
    for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
      const selector = makeSelector(entry.id);
      const relPath = relative(UNIFIED_INVENTORY_ROOT, entry.sourceFile);
      const tag = entry.isNew ? " 🆕 NEW" : "";
      const escapedSelector = escapeForTsString(selector);
      out += `  /** id: ${entry.id} | src: ${relPath}${tag} */\n`;
      out += `  ${entry.key}: "${escapedSelector}",\n`;

      // For dynamic IDs with a meaningful prefix, also emit positional XPath variants
      const dyn = makeDynamicSelectors(entry.id);
      if (dyn && dyn.prefix.length >= 4) {
        out += `  ${entry.key}First: '${dyn.first}',\n`;
        out += `  ${entry.key}Second: '${dyn.second}',\n`;
        out += `  ${entry.key}Nth: '${dyn.nth}',  // replace {n} with 1-based index\n`;
      }
    }
  }

  out += `} as const;\n\n`;
  out += `export type GLKey = keyof typeof GL;\n`;

  return out;
}

function toCamelCase(id: string): string {
  // Strip Swift interpolation segments like \(item.id) before conversion
  const stripped = id.replace(/\\\([^)]*\)/g, "");
  // Split on non-alphanumeric boundaries (underscore, hyphen, dot, space)
  const parts = stripped.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "unknown";
  return parts
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)))
    .join("");
}

/** Deduplicate camelCase keys by appending a numeric suffix to collisions */
function deduplicateKeys(
  entries: Array<RawLocator & { isNew: boolean }>,
): Array<RawLocator & { isNew: boolean; key: string }> {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = toCamelCase(entry.id);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const key = count === 0 ? base : `${base}${count + 1}`;
    return { ...entry, key };
  });
}

// ---------------------------------------------------------------------------
// Dynamic ID helpers — positional XPath variants for \(item.id) patterns
// ---------------------------------------------------------------------------

/**
 * Given a dynamic Swift ID like "product_catalog_item_\(item.id)", returns:
 *   - the BEGINSWITH predicate (already in makeSelector)
 *   - XPath for first / second / Nth occurrence
 *   - XPath for "by index" parameterised pattern
 *
 * The XCUIElement type is inferred from well-known ID prefixes; defaults to Other.
 */
function inferXCUIType(prefix: string): string {
  const p = prefix.toLowerCase();
  if (p.includes("button") || p.includes("edit") || p.includes("save") || p.includes("submit") || p.includes("add") || p.includes("cancel") || p.includes("view_all") || p.includes("start")) return "XCUIElementTypeButton";
  if (p.includes("image") || p.includes("thumbnail") || p.includes("icon") || p.includes("chevron")) return "XCUIElementTypeImage";
  if (p.includes("text") || p.includes("label") || p.includes("title") || p.includes("subtitle") || p.includes("name")) return "XCUIElementTypeStaticText";
  if (p.includes("input") || p.includes("field") || p.includes("search")) return "XCUIElementTypeTextField";
  return "XCUIElementTypeOther";
}

export interface DynamicSelectorSet {
  /** e.g. product_catalog_item_ */
  prefix: string;
  /** BEGINSWITH predicate — matches any item */
  any: string;
  /** XPath for the first occurrence */
  first: string;
  /** XPath for the second occurrence */
  second: string;
  /** XPath for the Nth occurrence — replace {n} at runtime */
  nth: string;
  /** XCUIElement type used in the XPath */
  xcuiType: string;
}

export function makeDynamicSelectors(id: string): DynamicSelectorSet | null {
  if (!id.includes("\\(")) return null;
  const prefix = id.split("\\(")[0];
  if (!prefix) return null;
  const xcuiType = inferXCUIType(prefix);
  return {
    prefix,
    any: `-ios predicate string:name BEGINSWITH "${prefix}"`,
    first: `(//${xcuiType}[starts-with(@name, "${prefix}")])[1]`,
    second: `(//${xcuiType}[starts-with(@name, "${prefix}")])[2]`,
    nth: `(//${xcuiType}[starts-with(@name, "${prefix}")])[{n}]`,
    xcuiType,
  };
}

// ---------------------------------------------------------------------------
// Auto-promotion into FlowActions.ts L map
// ---------------------------------------------------------------------------

/** Read the set of keys already present in the L map in FlowActions.ts */
function readExistingLKeys(): Set<string> {
  if (!existsSync(FLOW_ACTIONS_FILE)) return new Set();
  const content = readFileSync(FLOW_ACTIONS_FILE, "utf-8");
  const keys = new Set<string>();
  // Match "  someKey:" or "  someKey :" at the start of L map lines
  for (const m of content.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]+)\s*:/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

/**
 * Build the lines to insert into the L map for a set of new locators.
 * Static IDs → single `~id` line.
 * Dynamic IDs → BEGINSWITH predicate + first/second/Nth XPath variants.
 */
function buildPromotionLines(
  locators: GeneratedLocator[],
  existingKeys: Set<string>,
): string[] {
  const lines: string[] = [];
  // Track keys we're about to add so we don't emit duplicates within this batch
  const pendingKeys = new Set<string>(existingKeys);

  for (const loc of locators) {
    const dynamic = makeDynamicSelectors(loc.id);

    if (!dynamic) {
      // Static ID — skip if selector is a comment placeholder (no static prefix)
      if (loc.selector.startsWith("//")) continue;
      const key = toCamelCase(loc.id);
      if (!key || key === "unknown" || pendingKeys.has(key)) continue;
      pendingKeys.add(key);
      lines.push(`  ${key}: "${loc.selector}",  // auto: ${loc.sourceFile.split("/").pop()}`);
    } else {
      // Dynamic ID — only emit when there's a meaningful static prefix (≥4 chars)
      if (dynamic.prefix.length < 4) continue;
      const baseKey = toCamelCase(dynamic.prefix.replace(/_+$/, ""));
      if (!baseKey || baseKey === "unknown") continue;
      const variants: Array<[string, string]> = [
        [`${baseKey}Any`, dynamic.any],
        [`${baseKey}First`, dynamic.first],
        [`${baseKey}Second`, dynamic.second],
        [`${baseKey}Nth`, dynamic.nth],
      ];
      for (const [key, sel] of variants) {
        if (pendingKeys.has(key)) continue;
        pendingKeys.add(key);
        lines.push(`  ${key}: '${sel}',  // auto-dynamic: ${loc.sourceFile.split("/").pop()}`);
      }
    }
  }

  return lines;
}

/**
 * Insert or update the auto-promoted block in FlowActions.ts L map.
 * The block is delimited by PROMOTED_BLOCK_START / PROMOTED_BLOCK_END comments
 * so subsequent runs replace only those lines, never touching hand-written entries.
 */
export function promoteToFlowActions(newLocators: GeneratedLocator[], dryRun = false): {
  promoted: number;
  skipped: number;
  content?: string;
} {
  if (!existsSync(FLOW_ACTIONS_FILE)) {
    return { promoted: 0, skipped: newLocators.length };
  }

  const existing = readFileSync(FLOW_ACTIONS_FILE, "utf-8");
  const existingKeys = readExistingLKeys();

  const lines = buildPromotionLines(newLocators, existingKeys);
  const skipped = newLocators.length - lines.filter((l) => !l.startsWith("  //")).length;

  if (lines.length === 0) {
    return { promoted: 0, skipped };
  }

  const blockContent =
    `${PROMOTED_BLOCK_START}\n` +
    lines.join("\n") +
    `\n${PROMOTED_BLOCK_END}`;

  let updated: string;

  if (existing.includes(PROMOTED_BLOCK_START)) {
    // Replace the existing block
    const startIdx = existing.indexOf(PROMOTED_BLOCK_START);
    const endIdx = existing.indexOf(PROMOTED_BLOCK_END);
    if (endIdx === -1) {
      // Malformed — just replace from start marker to end of L map
      updated = existing.slice(0, startIdx) + blockContent + "\n";
    } else {
      updated =
        existing.slice(0, startIdx) +
        blockContent +
        existing.slice(endIdx + PROMOTED_BLOCK_END.length);
    }
  } else {
    // Insert before the closing `};` of the L map (first one in the file)
    const closingIdx = existing.indexOf("\n};");
    if (closingIdx === -1) {
      return { promoted: 0, skipped };
    }
    updated =
      existing.slice(0, closingIdx) +
      "\n" +
      blockContent +
      existing.slice(closingIdx);
  }

  if (!dryRun) {
    writeFileSync(FLOW_ACTIONS_FILE, updated, "utf-8");
  }

  const promotedCount = lines.filter((l) => !l.startsWith("  //")).length;
  return { promoted: promotedCount, skipped, content: dryRun ? updated : undefined };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate or update generated-locators.ts from Swift sources.
 *
 * @param changedSwiftFiles - If provided, only these files are scanned (PR mode).
 *                            Pass null / [] to scan all Swift sources.
 * @param allFiles          - Whether to scan ALL Swift sources regardless of
 *                            changedSwiftFiles (useful for a full refresh).
 */
export function runCodegen(opts: {
  changedSwiftFiles?: string[];
  allFiles?: boolean;
  dryRun?: boolean;
} = {}): CodegenResult {
  const scanFiles = opts.allFiles ? null : (opts.changedSwiftFiles ?? null);
  // In PR-diff mode we still need ALL existing locators for the output file —
  // otherwise we'd wipe entries from previous runs. So always do a full scan
  // for the base set, then mark the PR-specific IDs as "new".
  const allLocators = grepSwiftFiles(null);
  const prNewIds =
    scanFiles && scanFiles.length > 0
      ? new Set(grepSwiftFiles(scanFiles).map((l) => l.id))
      : null;

  const existingIds = readExistingIds();

  const annotated = allLocators.map((loc) => ({
    ...loc,
    isNew: prNewIds ? prNewIds.has(loc.id) && !existingIds.has(loc.id) : !existingIds.has(loc.id),
  }));

  const addedRaw = annotated.filter((l) => l.isNew);
  const timestamp = new Date().toISOString();
  const content = renderFile(annotated, timestamp);

  if (!opts.dryRun) {
    writeFileSync(GENERATED_FILE, content, "utf-8");
  }

  const added: GeneratedLocator[] = addedRaw.map((l) => ({
    id: l.id,
    selector: makeSelector(l.id),
    sourceFile: l.sourceFile,
    isNew: true,
  }));

  // Auto-promote new locators into the L map in FlowActions.ts
  const promotion = promoteToFlowActions(added, opts.dryRun ?? false);

  return {
    added,
    unchanged: annotated.length - addedRaw.length,
    totalWritten: annotated.length,
    outputPath: GENERATED_FILE,
    promoted: promotion.promoted,
    promotionSkipped: promotion.skipped,
  };
}
