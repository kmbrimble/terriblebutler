import { describe, expect, it } from 'vitest';
import { locationLabel } from './locationLabel';
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

describe('locationLabel', () => {
  it('prefers the stocked location over a stale zero-stock one, regardless of array order', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Old Pantry', quantity: 0 },
        { location_id: 2, location_name: 'Garage', quantity: 3 },
      ],
    });
    expect(locationLabel(item)).toBe('Garage');
  });

  it('shows "N locations" when genuinely stocked in more than one', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3 },
        { location_id: 2, location_name: 'Garage', quantity: 2 },
      ],
    });
    expect(locationLabel(item)).toBe('2 locations');
  });

  it('shows "N locations" when none of the multiple entries have stock', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 0 },
        { location_id: 2, location_name: 'Garage', quantity: 0 },
      ],
    });
    expect(locationLabel(item)).toBe('2 locations');
  });

  it('shows the lone location\'s name when there is only one entry, even at 0 stock', () => {
    const item = makeItem({ locations: [{ location_id: 1, location_name: 'Pantry', quantity: 0 }] });
    expect(locationLabel(item)).toBe('Pantry');
  });

  it('returns an empty string when there are no location entries at all', () => {
    expect(locationLabel(makeItem({ locations: [] }))).toBe('');
  });
});
