import { describe, expect, it } from 'vitest';
import { cardQuantity } from './cardQuantity';
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
