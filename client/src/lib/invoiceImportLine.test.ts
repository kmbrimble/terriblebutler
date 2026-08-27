import { describe, expect, it } from 'vitest';
import {
  resolveLineCategoryValue,
  resolveLineLocationValue,
  resolveLineNameValue,
  resolveLineContainerValue,
  resolveMatchFieldPatch,
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
    final_name: null,
    final_container_details: null,
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

describe('resolveLineNameValue / resolveLineContainerValue (fixes #40)', () => {
  it('prefers the edited final_name over raw_name', () => {
    expect(resolveLineNameValue(makeLine({ raw_name: 'COLES SHRIMP CHIPS 90G', final_name: 'Shrimp Chips' }))).toBe('Shrimp Chips');
  });

  it('falls back to raw_name when final_name is null', () => {
    expect(resolveLineNameValue(makeLine({ raw_name: 'COLES SHRIMP CHIPS 90G', final_name: null }))).toBe('COLES SHRIMP CHIPS 90G');
  });

  it('falls back to an empty string for container details when final_container_details is null', () => {
    expect(resolveLineContainerValue(makeLine({ final_container_details: null }))).toBe('');
  });

  it('returns the edited container details when set', () => {
    expect(resolveLineContainerValue(makeLine({ final_container_details: '90g bag' }))).toBe('90g bag');
  });
});

describe('resolveMatchFieldPatch', () => {
  const items = [{ id: 1, name: 'Pineapple soft drink' }, { id: 2, name: 'Raspberry soft drink' }];

  it('merges into an existing item on an exact (case-insensitive) name match', () => {
    expect(resolveMatchFieldPatch('pineapple soft drink', items, { matched_item_id: null, final_name: null })).toEqual({
      matched_item_id: 1,
      final_name: null,
    });
  });

  it('sets final_name to the typed text when it matches no existing item, instead of falling back to the raw invoice text', () => {
    expect(resolveMatchFieldPatch('Passionfruit soft drink', items, { matched_item_id: null, final_name: null })).toEqual({
      matched_item_id: null,
      final_name: 'Passionfruit soft drink',
    });
  });

  it('clears both fields when the field is emptied', () => {
    expect(resolveMatchFieldPatch('', items, { matched_item_id: 1, final_name: null })).toEqual({ matched_item_id: null, final_name: null });
    expect(resolveMatchFieldPatch('   ', items, { matched_item_id: null, final_name: 'Passionfruit soft drink' })).toEqual({
      matched_item_id: null,
      final_name: null,
    });
  });

  it('switches from a preferred new name to merging when the typed text is later completed into an existing item name', () => {
    expect(resolveMatchFieldPatch('Pineapple soft drink', items, { matched_item_id: null, final_name: 'Pineapple soft dr' })).toEqual({
      matched_item_id: 1,
      final_name: null,
    });
  });

  it('returns null (no patch needed) when the typed text already matches the current state', () => {
    expect(resolveMatchFieldPatch('', items, { matched_item_id: null, final_name: null })).toBeNull();
    expect(resolveMatchFieldPatch('Pineapple soft drink', items, { matched_item_id: 1, final_name: null })).toBeNull();
    expect(resolveMatchFieldPatch('Passionfruit soft drink', items, { matched_item_id: null, final_name: 'Passionfruit soft drink' })).toBeNull();
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
