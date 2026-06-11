/** Display helper — accepts 0–1 fraction or 0–100 percent. */
export function toConfidencePercent(value: number | undefined, fallback = 85): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(Math.min(100, Math.max(0, value)));
}
