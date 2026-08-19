import { describe, expect, it } from 'vitest';
import { sortItems } from './sortItems';
import type { Item } from './api';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 1,
    barcode: null,
    name: 'Item',
    location_id: null,
    category_id: null,
    container_details: '',
    quantity: 1,
    reorder_threshold: 0,
    is_ignored_grocery: 0,
    image_path: null,
    last_price: 0,
    lowest_price: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    location_name: null,
    category_name: null,
    locations: [],
    ...overrides,
  };
}

describe('sortItems', () => {
  it('does not mutate the input array', () => {
    const items = [makeItem({ id: 1, name: 'Zebra' }), makeItem({ id: 2, name: 'Apple' })];
    const original = [...items];
    sortItems(items, 'name', 'asc');
    expect(items).toEqual(original);
  });

  it('sorts by name case-insensitively, ascending and descending', () => {
    const items = [makeItem({ id: 1, name: 'zebra' }), makeItem({ id: 2, name: 'Apple' }), makeItem({ id: 3, name: 'mango' })];
    expect(sortItems(items, 'name', 'asc').map((i) => i.id)).toEqual([2, 3, 1]);
    expect(sortItems(items, 'name', 'desc').map((i) => i.id)).toEqual([1, 3, 2]);
  });

  it('sorts by created_at as real timestamps, not string comparison', () => {
    const items = [
      makeItem({ id: 1, created_at: '2026-03-01 00:00:00' }),
      makeItem({ id: 2, created_at: '2026-01-01 00:00:00' }),
      makeItem({ id: 3, created_at: '2026-02-01 00:00:00' }),
    ];
    expect(sortItems(items, 'created_at', 'asc').map((i) => i.id)).toEqual([2, 3, 1]);
    expect(sortItems(items, 'created_at', 'desc').map((i) => i.id)).toEqual([1, 3, 2]);
  });

  it('sorts by updated_at independently of created_at', () => {
    const items = [
      makeItem({ id: 1, created_at: '2026-01-01', updated_at: '2026-03-01' }),
      makeItem({ id: 2, created_at: '2026-03-01', updated_at: '2026-01-01' }),
    ];
    expect(sortItems(items, 'updated_at', 'asc').map((i) => i.id)).toEqual([2, 1]);
  });

  it('sorts by quantity numerically, ascending and descending', () => {
    const items = [makeItem({ id: 1, quantity: 10 }), makeItem({ id: 2, quantity: 2 }), makeItem({ id: 3, quantity: 5 })];
    expect(sortItems(items, 'quantity', 'asc').map((i) => i.id)).toEqual([2, 3, 1]);
    expect(sortItems(items, 'quantity', 'desc').map((i) => i.id)).toEqual([1, 3, 2]);
  });

  it('sorts by category name case-insensitively', () => {
    const items = [
      makeItem({ id: 1, category_name: 'Snacks' }),
      makeItem({ id: 2, category_name: 'dairy' }),
      makeItem({ id: 3, category_name: 'Frozen' }),
    ];
    expect(sortItems(items, 'category', 'asc').map((i) => i.id)).toEqual([2, 3, 1]);
  });

  it('sorts by the first location name in item.locations[]', () => {
    const items = [
      makeItem({ id: 1, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 1 }] }),
      makeItem({ id: 2, locations: [{ location_id: 2, location_name: 'Garage', quantity: 1 }] }),
      makeItem({ id: 3, locations: [] }),
    ];
    // Items with no location sort first ascending (empty string is lowest).
    expect(sortItems(items, 'location', 'asc').map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it('preserves relative order for equal sort keys (stable sort)', () => {
    const items = [
      makeItem({ id: 1, name: 'Same', quantity: 1 }),
      makeItem({ id: 2, name: 'Same', quantity: 2 }),
      makeItem({ id: 3, name: 'Same', quantity: 3 }),
    ];
    expect(sortItems(items, 'name', 'asc').map((i) => i.id)).toEqual([1, 2, 3]);
  });
});
