/** The latency contract, in one place, quoted by the HUD and the README. */
export const LATENCY = [
  "< 50ms → nothing, just paint",
  "50–200ms → 120ms crossfade",
  "200–500ms → shimmer",
  "> 500ms → inline progress + cancel",
  "error → 120ms shake",
];

export const BUDGETS = {
  ttfbP50: 16,
  ttfbP90: 50,
  scanP50: 200,
  hitRate: 0.8,
};
