// Plain TypeScript, no React/DOM imports. Ports the data-prep half of renderChart() and
// renderHistoryTable() from public/index.html (lines ~2158-2225) — sorting/filtering/extremes
// only; actual SVG/pixel layout is a rendering concern left to the component.

export interface PriceHistoryPoint {
  price: number;
  recorded_at: string;
}

interface PriceHistoryLike {
  price: number | null;
  recorded_at: string;
}

// Mirrors renderChart()'s validDataPoints filter (price > 0 excludes both 0 and null) and its
// oldest-to-newest sort.
export function chartPoints(history: PriceHistoryLike[]): PriceHistoryPoint[] {
  return history
    .filter((h): h is PriceHistoryPoint => (h.price ?? 0) > 0)
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
}

// Mirrors renderHistoryTable()'s maxPrice/minPrice (also price > 0 only).
export function priceExtremes(history: { price: number | null }[]): { max: number | null; min: number | null } {
  const valid = history.map((h) => h.price).filter((p): p is number => (p ?? 0) > 0);
  if (!valid.length) return { max: null, min: null };
  return { max: Math.max(...valid), min: Math.min(...valid) };
}
