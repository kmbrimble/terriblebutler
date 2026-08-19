import { describe, expect, it } from 'vitest';
import { chartPoints, priceExtremes } from './priceHistoryChart';

describe('chartPoints', () => {
  it('filters out non-positive and null prices, mirroring renderChart()\'s validDataPoints filter', () => {
    const history = [
      { price: 5, recorded_at: '2026-01-01' },
      { price: 0, recorded_at: '2026-01-02' },
      { price: null, recorded_at: '2026-01-03' },
      { price: -1, recorded_at: '2026-01-04' },
    ];
    expect(chartPoints(history)).toEqual([{ price: 5, recorded_at: '2026-01-01' }]);
  });

  it('sorts oldest to newest regardless of input order', () => {
    const history = [
      { price: 3, recorded_at: '2026-03-01' },
      { price: 1, recorded_at: '2026-01-01' },
      { price: 2, recorded_at: '2026-02-01' },
    ];
    expect(chartPoints(history).map((p) => p.price)).toEqual([1, 2, 3]);
  });

  it('returns an empty array when there is no history or no valid prices', () => {
    expect(chartPoints([])).toEqual([]);
    expect(chartPoints([{ price: 0, recorded_at: '2026-01-01' }])).toEqual([]);
  });
});

describe('priceExtremes', () => {
  it('returns null/null for no history or no valid prices', () => {
    expect(priceExtremes([])).toEqual({ max: null, min: null });
    expect(priceExtremes([{ price: 0 }, { price: null }])).toEqual({ max: null, min: null });
  });

  it('finds the max and min among valid (>0) prices only', () => {
    expect(priceExtremes([{ price: 5 }, { price: 0 }, { price: 2 }, { price: null }])).toEqual({ max: 5, min: 2 });
  });

  it('a single valid price is both the max and the min', () => {
    expect(priceExtremes([{ price: 4 }])).toEqual({ max: 4, min: 4 });
  });
});
