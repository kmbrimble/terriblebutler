import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QtyModal } from './QtyModal';
import type { Item, Location } from '../lib/api';

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
    const html = renderToStaticMarkup(<QtyModal item={multiLocationItem} locations={[]} onClose={() => {}} />);
    expect(amountValue(html)).toBe('3');
  });

  it('pre-selects the given location and its quantity', () => {
    const html = renderToStaticMarkup(<QtyModal item={multiLocationItem} locations={[]} initialLocationId={2} onClose={() => {}} />);
    expect(amountValue(html)).toBe('5');
  });

  it('falls back to the first location if initialLocationId matches nothing', () => {
    const html = renderToStaticMarkup(<QtyModal item={multiLocationItem} locations={[]} initialLocationId={999} onClose={() => {}} />);
    expect(amountValue(html)).toBe('3');
  });

  it('is ignored for single-location items (no location picker, uses item.quantity)', () => {
    const singleLocationItem = makeItem({ quantity: 7, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 7 }] });
    const html = renderToStaticMarkup(<QtyModal item={singleLocationItem} locations={[]} initialLocationId={1} onClose={() => {}} />);
    expect(amountValue(html)).toBe('7');
  });
});

describe('QtyModal open toggle (fixes #35)', () => {
  it('is not rendered for single-location items (the card\'s own Open button covers that case)', () => {
    const singleLocationItem = makeItem({ quantity: 7, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 7 }] });
    const html = renderToStaticMarkup(<QtyModal item={singleLocationItem} locations={[]} onClose={() => {}} />);
    expect(html).not.toContain('qty-modal-open-toggle');
  });

  it('reflects the initially-selected location\'s is_open state for multi-location items', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 1 },
        { location_id: 2, location_name: 'Garage', quantity: 5, is_open: 0 },
      ],
    });
    const html = renderToStaticMarkup(<QtyModal item={item} locations={[]} onClose={() => {}} />);
    const match = html.match(/<input[^>]*data-testid="qty-modal-open-toggle"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('checked=""');
  });
});

describe('QtyModal move-to-location control (fixes #39)', () => {
  const pantry: Location = { id: 1, name: 'Pantry' };
  const garage: Location = { id: 2, name: 'Garage' };
  const freezer: Location = { id: 3, name: 'Freezer' };

  it('offers every other known location as a move destination, excluding the current one', () => {
    const singleLocationItem = makeItem({ quantity: 7, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 7 }] });
    const html = renderToStaticMarkup(
      <QtyModal item={singleLocationItem} locations={[pantry, garage, freezer]} onClose={() => {}} />
    );
    expect(html).toContain('qty-modal-move-location-select');
    expect(html).not.toContain('>Pantry</option>');
    expect(html).toContain('>Garage</option>');
    expect(html).toContain('>Freezer</option>');
  });

  it('hides the move control entirely when there is nowhere else to move stock to', () => {
    const singleLocationItem = makeItem({ quantity: 7, locations: [{ location_id: 1, location_name: 'Pantry', quantity: 7 }] });
    const html = renderToStaticMarkup(<QtyModal item={singleLocationItem} locations={[pantry]} onClose={() => {}} />);
    expect(html).not.toContain('qty-modal-move-location-select');
  });
});

describe('QtyModal amount step/floor', () => {
  it('uses a whole-number step floored at 0, not the legacy 0.1 with no floor', () => {
    const html = renderToStaticMarkup(<QtyModal item={makeItem()} locations={[]} onClose={() => {}} />);
    const match = html.match(/<input[^>]*data-testid="qty-modal-amount-input"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('step="1"');
    expect(match![0]).toContain('min="0"');
  });
});
