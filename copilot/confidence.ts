/** Normalize confidence to 0–100 whether stored as fraction (0.87) or percent (87). */
export function toConfidencePercent(value: number | undefined, fallback = 85): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function clampConfidence(value: number): number {
  return Math.min(99, Math.max(58, Math.round(value)));
}
