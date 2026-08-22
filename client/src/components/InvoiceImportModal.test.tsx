import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceImportLineRow } from './InvoiceImportModal';
import type { InvoiceImportLine } from '../lib/api';

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
    barcode_scanned: null,
    qty_confirmed: null,
    line_status: 'pending',
    ...overrides,
  };
}

describe('InvoiceImportLineRow Qty confirmed step/floor', () => {
  it('uses a whole-number step floored at 0, not the legacy 0.1 with no floor', () => {
    const html = renderToStaticMarkup(
      <InvoiceImportLineRow line={makeLine()} categories={[]} locations={[]} onPatch={() => {}} onScanBarcode={() => {}} />
    );
    const match = html.match(/<input[^>]*data-testid="invoice-import-line-qty-input"[^>]*>/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain('step="1"');
    expect(match![0]).toContain('min="0"');
  });
});
