import Fuse from 'fuse.js';
import { describe, it, expect } from 'vitest';
import { normaliseName, findMatch } from '../item-matching.js';

function fuseFor(items) {
  return new Fuse(items, { keys: ['name'], threshold: 0.3 });
}

describe('normaliseName', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normaliseName('  Baked   Beans  ')).toBe('baked beans');
  });
});

describe('findMatch', () => {
  const existing = [
    { id: 1, name: 'Baked Beans 420g', barcode: '9310072000015' },
    { id: 2, name: 'Tinned Tomatoes', barcode: null },
  ];

  it('prefers a barcode match over everything else', () => {
    const result = findMatch(existing, { barcode: '9310072000015', name: 'Something Else Entirely' }, fuseFor(existing));
    expect(result.type).toBe('barcode');
    expect(result.item.id).toBe(1);
  });

  it('falls back to an exact normalised-name match when no barcode match', () => {
    const result = findMatch(existing, { barcode: null, name: '  baked   beans 420g ' }, fuseFor(existing));
    expect(result.type).toBe('exact_name');
    expect(result.item.id).toBe(1);
  });

  it('returns a fuzzy suggestion (no auto-selected item) when only a fuzzy hit exists', () => {
    const result = findMatch(existing, { barcode: null, name: 'Baked Beanz 420g' }, fuseFor(existing));
    expect(result.type).toBe('fuzzy');
    expect(result.item).toBeNull();
    expect(result.candidates.map((c) => c.id)).toContain(1);
  });

  it('returns no match when nothing is close', () => {
    const result = findMatch(existing, { barcode: null, name: 'Completely Unrelated Product' }, fuseFor(existing));
    expect(result.type).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('works without a fuse instance (fuzzy step skipped, not an error)', () => {
    const result = findMatch(existing, { barcode: null, name: 'Baked Beanz 420g' }, null);
    expect(result.type).toBeNull();
  });
});
