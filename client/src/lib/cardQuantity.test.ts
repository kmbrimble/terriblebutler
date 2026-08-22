import { describe, expect, it } from 'vitest';
import { cardQuantity, splitAvailability } from './cardQuantity';
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

describe('cardQuantity', () => {
  it('outside a location tab, returns the item total', () => {
    const item = makeItem({
      quantity: 5,
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3 },
        { location_id: 2, location_name: 'Garage', quantity: 2 },
      ],
    });
    expect(cardQuantity(item, { type: 'all', id: null })).toBe(5);
  });

  it('inside a location tab, returns just that location\'s quantity', () => {
    const item = makeItem({
      quantity: 5,
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3 },
        { location_id: 2, location_name: 'Garage', quantity: 2 },
      ],
    });
    expect(cardQuantity(item, { type: 'location', id: 2 })).toBe(2);
  });

  it('inside a location tab the item isn\'t stocked in, returns 0 rather than the total', () => {
    const item = makeItem({ quantity: 5, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 5 }] });
    expect(cardQuantity(item, { type: 'location', id: 99 })).toBe(0);
  });

  it('the grocery and ignored tabs are treated the same as "all" (item total)', () => {
    const item = makeItem({ quantity: 4, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 4 }] });
    expect(cardQuantity(item, { type: 'grocery', id: null })).toBe(4);
    expect(cardQuantity(item, { type: 'ignored', id: null })).toBe(4);
  });
});

describe('splitAvailability', () => {
  it('in the "all" tab, splits by item total, preserving order within each section', () => {
    const inStockA = makeItem({ id: 1, quantity: 2 });
    const outOfStock = makeItem({ id: 2, quantity: 0 });
    const inStockB = makeItem({ id: 3, quantity: 5 });
    const result = splitAvailability([inStockA, outOfStock, inStockB], { type: 'all', id: null });
    expect(result.available.map((i) => i.id)).toEqual([1, 3]);
    expect(result.unavailable.map((i) => i.id)).toEqual([2]);
  });

  it('in a location tab, splits by that location\'s own quantity, not the item total', () => {
    const stockedHere = makeItem({ id: 1, quantity: 5, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 5 }] });
    const stockedElsewhereOnly = makeItem({
      id: 2,
      quantity: 5,
      locations: [{ location_id: 2, location_name: 'Garage', quantity: 5 }],
    });
    const result = splitAvailability([stockedHere, stockedElsewhereOnly], { type: 'location', id: 1 });
    expect(result.available.map((i) => i.id)).toEqual([1]);
    expect(result.unavailable.map((i) => i.id)).toEqual([2]);
  });

  it('the grocery tab is not split — every item stays in "available" even at 0 quantity', () => {
    const zeroQty = makeItem({ id: 1, quantity: 0, reorder_threshold: 2 });
    const result = splitAvailability([zeroQty], { type: 'grocery', id: null });
    expect(result.available.map((i) => i.id)).toEqual([1]);
    expect(result.unavailable).toEqual([]);
  });

  it('the ignored tab is not split — every item stays in "available" even at 0 quantity', () => {
    const zeroQty = makeItem({ id: 1, quantity: 0, is_ignored_grocery: 1 });
    const result = splitAvailability([zeroQty], { type: 'ignored', id: null });
    expect(result.available.map((i) => i.id)).toEqual([1]);
    expect(result.unavailable).toEqual([]);
  });
});
