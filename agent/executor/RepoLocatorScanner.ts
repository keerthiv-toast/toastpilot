import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWIFT_SOURCE_ROOT =
  process.env.IOS_SWIFT_SOURCE_ROOT ??
  join(__dirname, "../../../../../ToastUnifiedInventory/Sources");
const LOCATOR_TS_ROOT =
  process.env.UNIFIED_INVENTORY_ROOT
    ? join(process.env.UNIFIED_INVENTORY_ROOT, "automation")
    : join(__dirname, "../../../../../ToastUnifiedInventory/automation");

export interface LocatorEntry {
  id: string;
  selector: string;
  source: "swift" | "ts-locator";
  file?: string;
}

export interface ScanResult {
  locators: Map<string, LocatorEntry>;
  /** All raw IDs found sorted alphabetically */
  allIds: string[];
}

let _cache: ScanResult | null = null;

/**
 * Scans the UnifiedInventory Swift source and automation TS locator files for
 * accessibilityIdentifier values. Results are cached for the process lifetime.
 */
export function scanRepoLocators(forceRefresh = false): ScanResult {
  if (_cache && !forceRefresh) return _cache;

  const locators = new Map<string, LocatorEntry>();

  // 1. Swift sources: .accessibilityIdentifier("some_id")
  if (existsSync(SWIFT_SOURCE_ROOT)) {
    try {
      const raw = execSync(
        `grep -rn --include="*.swift" 'accessibilityIdentifier' "${SWIFT_SOURCE_ROOT}"`,
        { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
      );
      for (const line of raw.split("\n")) {
        const match = line.match(/accessibilityIdentifier\s*\(\s*"([^"]+)"/);
        if (!match) continue;
        const id = match[1];
        if (!locators.has(id)) {
          const filePart = line.split(":")[0] ?? "";
          locators.set(id, {
            id,
            selector: id.includes(" ") || id.includes("-")
              ? `-ios predicate string:name == "${id}"`
              : `~${id}`,
            source: "swift",
            file: filePart,
          });
        }
      }
    } catch {
      /* swift source unavailable — continue */
    }
  }

  // 2. TS locator files under automation/features/**/locators/*.ts
  if (existsSync(LOCATOR_TS_ROOT)) {
    try {
      const raw = execSync(
        `find "${LOCATOR_TS_ROOT}" -path "*/locators/*.ts" -type f`,
        { encoding: "utf-8" },
      );
      for (const filePath of raw.split("\n").filter(Boolean)) {
        try {
          const content = readFileSync(filePath, "utf-8");
          // Match ~identifier or predicate/xpath lines assigned to identifiers
          const idMatches = [...content.matchAll(/"~([a-zA-Z0-9_]+)"/g)];
          for (const m of idMatches) {
            const id = m[1];
            if (!locators.has(id)) {
              locators.set(id, { id, selector: `~${id}`, source: "ts-locator", file: filePath });
            }
          }
        } catch {
          /* skip unreadable file */
        }
      }
    } catch {
      /* locator TS root unavailable */
    }
  }

  const allIds = [...locators.keys()].sort();
  _cache = { locators, allIds };
  return _cache;
}

/**
 * Given a partial name or description, returns candidate locator entries whose
 * ID contains any of the words in the query (case-insensitive).
 */
export function findLocators(query: string, maxResults = 10): LocatorEntry[] {
  const result = scanRepoLocators();
  const words = query.toLowerCase().split(/[\s_\-]+/).filter((w) => w.length > 2);

  const scored: Array<{ entry: LocatorEntry; score: number }> = [];
  for (const entry of result.locators.values()) {
    const lower = entry.id.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (lower === word) score += 3;
      else if (lower.startsWith(word) || lower.endsWith(word)) score += 2;
      else if (lower.includes(word)) score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((x) => x.entry);
}

/**
 * Checks whether a given accessibilityIdentifier exists in the scanned repo
 * sources. Returns the canonical selector if found, null otherwise.
 */
export function resolveLocator(id: string): string | null {
  const result = scanRepoLocators();
  // Exact match
  if (result.locators.has(id)) return result.locators.get(id)!.selector;
  // Strip leading ~ for lookup
  const bare = id.startsWith("~") ? id.slice(1) : id;
  if (result.locators.has(bare)) return result.locators.get(bare)!.selector;
  return null;
}

/**
 * Returns a human-readable summary of all scanned IDs, one per line.
 * Useful for logging during selector-healing failures.
 */
export function formatLocatorList(): string {
  const result = scanRepoLocators();
  return result.allIds.map((id) => `  ~${id}`).join("\n");
}
