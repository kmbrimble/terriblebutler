import { describe, expect, it } from 'vitest';
import {
  resolveLineCategoryValue,
  resolveLineLocationValue,
  isCommitEnabled,
  matchLabel,
  formatSummaryLine,
} from './invoiceImportLine';
import type { InvoiceImport, InvoiceImportLine } from './api';

function makeLine(overrides: Partial<InvoiceImportLine> = {}): InvoiceImportLine {
  return {
    id: 1,
    import_id: 1,
    raw_name: 'Test Product',
    qty_ordered: 1,
    qty_supplied: 1,
    unit_price: 1,
    line_total: 1,
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

function makeImport(overrides: Partial<InvoiceImport> = {}): InvoiceImport {
  return { id: 1, retailer: 'coles', invoice_number: '12345', invoice_date: '2026-08-01', status: 'in_progress', ...overrides };
}

describe('resolveLineCategoryValue / resolveLineLocationValue', () => {
  it('prefers the final value when set', () => {
    expect(resolveLineCategoryValue(makeLine({ final_category_id: 3, suggested_category_id: 9 }))).toBe(3);
    expect(resolveLineLocationValue(makeLine({ final_location_id: 3, suggested_location_id: 9 }))).toBe(3);
  });

  it('falls back to the suggested value when final is null', () => {
    expect(resolveLineCategoryValue(makeLine({ final_category_id: null, suggested_category_id: 9 }))).toBe(9);
    expect(resolveLineLocationValue(makeLine({ final_location_id: null, suggested_location_id: 9 }))).toBe(9);
  });

  it('falls back to an empty string when both are null', () => {
    expect(resolveLineCategoryValue(makeLine({ final_category_id: null, suggested_category_id: null }))).toBe('');
    expect(resolveLineLocationValue(makeLine({ final_location_id: null, suggested_location_id: null }))).toBe('');
  });
});

describe('isCommitEnabled', () => {
  it('is disabled while any line is pending', () => {
    expect(isCommitEnabled([makeLine({ line_status: 'reviewed' }), makeLine({ line_status: 'pending' })])).toBe(false);
  });

  it('is enabled once every line is reviewed or skipped', () => {
    expect(isCommitEnabled([makeLine({ line_status: 'reviewed' }), makeLine({ line_status: 'skipped' })])).toBe(true);
  });
});

describe('matchLabel', () => {
  it('reports a merge when matched_item_id is set', () => {
    expect(matchLabel(makeLine({ matched_item_id: 42 }))).toBe('Will merge into an existing item');
  });

  it('reports a new item when matched_item_id is null', () => {
    expect(matchLabel(makeLine({ matched_item_id: null }))).toBe('Will be added as a new item');
  });
});

describe('formatSummaryLine', () => {
  it('capitalises the retailer and pluralises line count', () => {
    expect(formatSummaryLine(makeImport({ retailer: 'coles', invoice_number: '999', invoice_date: '2026-08-01' }), 32)).toBe(
      'Coles — invoice 999 (2026-08-01) — 32 lines'
    );
  });

  it('uses singular "line" for exactly one line', () => {
    expect(formatSummaryLine(makeImport(), 1).endsWith('1 line')).toBe(true);
  });

  it('falls back to placeholder text when retailer/invoice_number/invoice_date are missing', () => {
    expect(formatSummaryLine(makeImport({ retailer: null, invoice_number: null, invoice_date: null }), 5)).toBe(
      'Unknown retailer — invoice ? (unknown date) — 5 lines'
    );
  });
});
