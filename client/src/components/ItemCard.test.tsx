import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemCard } from './ItemCard';
import type { Item } from '../lib/api';

// Regression test for a crash on real inventory data: items.last_price/lowest_price are
// REAL DEFAULT 0 columns, but that DEFAULT was added later via ALTER TABLE, so pre-existing
// live rows are genuinely NULL (fresh rows via POST/PUT /api/items always get 0 via
// recalculateItemPrices()'s `|| 0` writes — the API can never produce a fresh NULL, which is
// why this can only be reproduced by constructing the Item directly, not via an e2e fixture).

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

const noop = () => {};
const cardProps = { tab: { type: 'all' as const, id: null }, onEdit: noop, onOpenDetail: noop, onAdjust: noop, onOpenQtyModal: noop, onToggleIgnore: noop, onToggleOpen: noop };

describe('ItemCard', () => {
  it('expanded view renders without throwing when last_price and lowest_price are null', () => {
    const item = makeItem({ last_price: null, lowest_price: null });
    expect(() => renderToStaticMarkup(<ItemCard item={item} viewMode="expanded" {...cardProps} />)).not.toThrow();
  });

  it('expanded view falls back to $0.00 for null prices, matching public/index.html\'s convention', () => {
    const item = makeItem({ last_price: null, lowest_price: null });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="expanded" {...cardProps} />);
    expect(html).toContain('Last Price: $0.00');
    expect(html).toContain('Lowest: $0.00');
  });

  it('expanded view still renders real prices correctly', () => {
    const item = makeItem({ last_price: 4.5, lowest_price: 3.99 });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="expanded" {...cardProps} />);
    expect(html).toContain('Last Price: $4.50');
    expect(html).toContain('Lowest: $3.99');
  });

  it('compact view renders without throwing when prices are null (defensive; it never reads them)', () => {
    const item = makeItem({ last_price: null, lowest_price: null });
    expect(() => renderToStaticMarkup(<ItemCard item={item} viewMode="compact" {...cardProps} />)).not.toThrow();
  });
});

describe('ItemCard "open" status', () => {
  function qtyDisplayTag(html: string): string {
    const match = html.match(/<button[^>]*data-testid="qty-display-button"[^>]*>/);
    expect(match).toBeTruthy();
    return match![0];
  }

  it('renders the qty display in red when the item is open here', () => {
    const item = makeItem({ locations: [{ location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 1 }] });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="compact" {...cardProps} />);
    expect(qtyDisplayTag(html)).toContain('text-red-500');
  });

  it('does not render the qty display in red when not open', () => {
    const item = makeItem({ locations: [{ location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 0 }] });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="compact" {...cardProps} />);
    expect(qtyDisplayTag(html)).not.toContain('text-red-500');
  });

  it('shows the open-toggle button when the target location is unambiguous (single-location item)', () => {
    const item = makeItem({ locations: [{ location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 0 }] });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="compact" {...cardProps} />);
    expect(html).toContain('data-testid="open-toggle-button"');
  });

  it('hides the open-toggle button when the target location is ambiguous (multi-location item outside a location tab)', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 0 },
        { location_id: 2, location_name: 'Garage', quantity: 1, is_open: 0 },
      ],
    });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="compact" {...cardProps} />);
    expect(html).not.toContain('data-testid="open-toggle-button"');
  });

  it('shows the open-toggle button in expanded view too, not just compact', () => {
    const item = makeItem({ locations: [{ location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 0 }] });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="expanded" {...cardProps} />);
    expect(html).toContain('data-testid="open-toggle-button"');
  });

  it('shows the open-toggle button for a multi-location item when inside that location\'s own tab', () => {
    const item = makeItem({
      locations: [
        { location_id: 1, location_name: 'Pantry', quantity: 3, is_open: 0 },
        { location_id: 2, location_name: 'Garage', quantity: 1, is_open: 0 },
      ],
    });
    const html = renderToStaticMarkup(<ItemCard item={item} viewMode="compact" tab={{ type: 'location', id: 1 }} onEdit={noop} onOpenDetail={noop} onAdjust={noop} onOpenQtyModal={noop} onToggleIgnore={noop} onToggleOpen={noop} />);
    expect(html).toContain('data-testid="open-toggle-button"');
  });
});
