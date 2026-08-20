import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QtyModal } from './QtyModal';
import type { Item } from '../lib/api';

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

function amountValue(html: string): string {
  const match = html.match(/data-testid="qty-modal-amount-input"[^>]*value="([^"]*)"/);
  expect(match).toBeTruthy();
  return match![1];
}

const multiLocationItem = makeItem({
  locations: [
    { location_id: 1, location_name: 'Pantry', quantity: 3 },
    { location_id: 2, location_name: 'Garage', quantity: 5 },
  ],
});

describe('QtyModal initialLocationId', () => {
  it('defaults to the first location when omitted (unchanged main-card behaviour)', () => {
    const html = renderToStaticMarkup(<QtyModal item={multiLocationItem} onClose={() => {}} />);
    expect(amountValue(html)).toBe('3');
  });

  it('pre-selects the given location and its quantity', () => {
    const html = renderToStaticMarkup(<QtyModal item={multiLocationItem} initialLocationId={2} onClose={() => {}} />);
    expect(amountValue(html)).toBe('5');
  });

  it('falls back to the first location if initialLocationId matches nothing', () => {
    const html = renderToStaticMarkup(<QtyModal item={multiLocationItem} initialLocationId={999} onClose={() => {}} />);
    expect(amountValue(html)).toBe('3');
  });

  it('is ignored for single-location items (no location picker, uses item.quantity)', () => {
    const singleLocationItem = makeItem({ quantity: 7, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 7 }] });
    const html = renderToStaticMarkup(<QtyModal item={singleLocationItem} initialLocationId={1} onClose={() => {}} />);
    expect(amountValue(html)).toBe('7');
  });
});
