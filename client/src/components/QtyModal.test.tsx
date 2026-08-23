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

describe('QtyModal open toggle (fixes #35)', () => {
  it('is not rendered for single-location items (the card\'s own Open button covers that case)', () => {
    const singleLocationItem = makeItem({ quantity: 7, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 7 }] });
    const html = renderToStaticMarkup(<QtyModal item={singleLocationItem} onClose={() => {}} />);
    expect(html).not.toContain('qty-modal-open-toggle');
  });

  it('reflects the initially-selected location\'s is_open state for multi-location items', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 1 },
        { location_id: 2, location_name: 'Garage', quantity: 5, is_open: 0 },
      ],
    });
    const html = renderToStaticMarkup(<QtyModal item={item} onClose={() => {}} />);
    const match = html.match(/<input[^>]*data-testid="qty-modal-open-toggle"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('checked=""');
  });
});

describe('QtyModal amount step/floor', () => {
  it('uses a whole-number step floored at 0, not the legacy 0.1 with no floor', () => {
    const html = renderToStaticMarkup(<QtyModal item={makeItem()} onClose={() => {}} />);
    const match = html.match(/<input[^>]*data-testid="qty-modal-amount-input"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('step="1"');
    expect(match![0]).toContain('min="0"');
  });
});
