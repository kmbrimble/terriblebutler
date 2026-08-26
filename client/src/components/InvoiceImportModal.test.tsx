import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceImportLineRow } from './InvoiceImportModal';
import type { InvoiceImportLine, Item } from '../lib/api';

function makeLine(overrides: Partial<InvoiceImportLine> = {}): InvoiceImportLine {
  return {
    id: 1,
    import_id: 1,
    raw_name: 'Milk 2L',
    qty_ordered: 1,
    qty_supplied: 1,
    unit_price: 4.5,
    line_total: 4.5,
    gst_applicable: 0,
    matched_item_id: null,
    suggested_category_id: null,
    suggested_location_id: null,
    final_category_id: null,
    final_location_id: null,
    final_name: null,
    final_container_details: null,
    barcode_scanned: null,
    qty_confirmed: null,
    line_status: 'pending',
    ...overrides,
  };
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 1,
    barcode: null,
    name: 'Existing Item',
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

describe('InvoiceImportLineRow Qty confirmed step/floor', () => {
  it('uses a whole-number step floored at 0, not the legacy 0.1 with no floor', () => {
    const html = renderToStaticMarkup(
      <InvoiceImportLineRow line={makeLine()} categories={[]} locations={[]} items={[]} onPatch={() => {}} onScanBarcode={() => {}} />
    );
    const match = html.match(/<input[^>]*data-testid="invoice-import-line-qty-input"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('step="1"');
    expect(match![0]).toContain('min="0"');
  });
});

describe('InvoiceImportLineRow name/container editing and match override (fixes #40)', () => {
  it('renders the name input pre-filled from raw_name when unedited', () => {
    const html = renderToStaticMarkup(
      <InvoiceImportLineRow line={makeLine({ raw_name: 'COLES SHRIMP CHIPS 90G' })} categories={[]} locations={[]} items={[]} onPatch={() => {}} onScanBarcode={() => {}} />
    );
    const match = html.match(/<input[^>]*data-testid="invoice-import-line-name-input"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('value="COLES SHRIMP CHIPS 90G"');
  });

  it('renders the name input pre-filled from final_name once edited', () => {
    const html = renderToStaticMarkup(
      <InvoiceImportLineRow
        line={makeLine({ raw_name: 'COLES SHRIMP CHIPS 90G', final_name: 'Shrimp Chips' })}
        categories={[]}
        locations={[]}
        items={[]}
        onPatch={() => {}}
        onScanBarcode={() => {}}
      />
    );
    const match = html.match(/<input[^>]*data-testid="invoice-import-line-name-input"[^>]*>/);
    expect(match![0]).toContain('value="Shrimp Chips"');
  });

  it('offers every known item as a match-override option in the datalist', () => {
    const items = [makeItem({ id: 1, name: 'Shrimp Chips' }), makeItem({ id: 2, name: 'Rice Crackers' })];
    const html = renderToStaticMarkup(
      <InvoiceImportLineRow line={makeLine()} categories={[]} locations={[]} items={items} onPatch={() => {}} onScanBarcode={() => {}} />
    );
    expect(html).toContain('value="Shrimp Chips"');
    expect(html).toContain('value="Rice Crackers"');
  });

  it('pre-fills the match input from the currently matched item', () => {
    const items = [makeItem({ id: 5, name: 'Matched Product' })];
    const html = renderToStaticMarkup(
      <InvoiceImportLineRow line={makeLine({ matched_item_id: 5 })} categories={[]} locations={[]} items={items} onPatch={() => {}} onScanBarcode={() => {}} />
    );
    const match = html.match(/<input[^>]*data-testid="invoice-import-line-match-input"[^>]*>/);
    expect(match![0]).toContain('value="Matched Product"');
  });
});
