import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemFormModal, matchCategoryId } from './ItemFormModal';
import type { Item, Category } from '../lib/api';

// Regression coverage for fields the edit-prefill reads directly from a real item: barcode
// and category_id are genuinely NULL on live rows (49/51 and 50/51 respectively, per the live
// DB audit) despite being typed non-null in earlier, fixture-driven code. Neither an e2e
// fixture nor the live API can produce a *fresh* NULL for container_details/reorder_threshold
// (0/51 NULL live, both DEFAULT-backed with no code path that writes NULL) — they're guarded
// here anyway, matching public/index.html's unconditional `|| ''`/`|| 0`, but the crash-risk
// fields worth constructing directly are barcode and category_id.

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

const categories: Category[] = [
  { id: 10, name: 'Frozen' },
  { id: 11, name: 'Pantry' },
];

describe('matchCategoryId', () => {
  it('returns the empty string when both category_id and category_name are null', () => {
    expect(matchCategoryId(makeItem({ category_id: null, category_name: null }), categories)).toBe('');
  });

  it('returns category_id directly when set', () => {
    expect(matchCategoryId(makeItem({ category_id: 11, category_name: 'Pantry' }), categories)).toBe(11);
  });

  it('falls back to matching category_name against the categories list when category_id is null', () => {
    expect(matchCategoryId(makeItem({ category_id: null, category_name: 'Frozen' }), categories)).toBe(10);
  });

  it('returns the empty string when category_id is null and category_name matches nothing', () => {
    expect(matchCategoryId(makeItem({ category_id: null, category_name: 'Deleted Category' }), categories)).toBe('');
  });
});

describe('ItemFormModal edit-mode prefill null-guards', () => {
  it('renders without throwing when barcode, category_id, container_details, and reorder_threshold are all null', () => {
    const item = makeItem({ barcode: null, category_id: null, container_details: null as unknown as string, reorder_threshold: null as unknown as number });
    expect(() =>
      renderToStaticMarkup(
        <ItemFormModal mode="edit" item={item} locations={[]} categories={categories} onClose={() => {}} />
      )
    ).not.toThrow();
  });

  it('falls back to empty-string/zero display values instead of the literal string "null"', () => {
    const item = makeItem({ barcode: null, category_id: null, container_details: null as unknown as string, reorder_threshold: null as unknown as number });
    const html = renderToStaticMarkup(
      <ItemFormModal mode="edit" item={item} locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(html).not.toContain('value="null"');
    expect(html).not.toContain('>null<');
  });

  it('prefills real values correctly (defensive; confirms the guard has a real branch to skip)', () => {
    const item = makeItem({ barcode: '123456', category_id: 11, container_details: '500g tin', reorder_threshold: 2 });
    const html = renderToStaticMarkup(
      <ItemFormModal mode="edit" item={item} locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(html).toContain('value="123456"');
    expect(html).toContain('value="500g tin"');
  });
});

describe('ItemFormModal "Save and Add Another" button', () => {
  it('is present in add mode', () => {
    const html = renderToStaticMarkup(<ItemFormModal mode="add" locations={[]} categories={categories} onClose={() => {}} />);
    expect(html).toContain('data-testid="item-form-save-add-another-button"');
  });

  it('is absent in edit mode ("add another" only makes sense when adding)', () => {
    const item = makeItem();
    const html = renderToStaticMarkup(
      <ItemFormModal mode="edit" item={item} locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(html).not.toContain('data-testid="item-form-save-add-another-button"');
  });
});

describe('ItemFormModal reorder-threshold step', () => {
  // Regression test: public/index.html's itemThreshold input also uses step="0.1" (confirmed
  // by direct inspection, not assumed) — this is a pre-existing legacy usability bug, not a
  // stage-3 regression. Fixed here by deliberate, explicit decision to diverge from legacy:
  // whole-number steps are what a reorder threshold should have, regardless of what legacy does.
  function thresholdInputTag(html: string): string {
    const match = html.match(/<input[^>]*data-testid="item-threshold-input"[^>]*>/);
    expect(match).toBeTruthy();
    return match![0];
  }

  it('uses a whole-number step, not 0.1, in both add and edit mode', () => {
    const addHtml = renderToStaticMarkup(
      <ItemFormModal mode="add" locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(thresholdInputTag(addHtml)).toContain('step="1"');

    const item = makeItem();
    const editHtml = renderToStaticMarkup(
      <ItemFormModal mode="edit" item={item} locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(thresholdInputTag(editHtml)).toContain('step="1"');
  });

  it('is floored at 0 (min="0") in both add and edit mode, so it can\'t go negative', () => {
    const addHtml = renderToStaticMarkup(
      <ItemFormModal mode="add" locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(thresholdInputTag(addHtml)).toContain('min="0"');

    const item = makeItem();
    const editHtml = renderToStaticMarkup(
      <ItemFormModal mode="edit" item={item} locations={[]} categories={categories} onClose={() => {}} />
    );
    expect(thresholdInputTag(editHtml)).toContain('min="0"');
  });
});

describe('ItemFormModal add-mode Quantity step/floor', () => {
  function quantityInputTag(html: string): string {
    const match = html.match(/<input[^>]*data-testid="item-quantity-input"[^>]*>/);
    expect(match).toBeTruthy();
    return match![0];
  }

  it('uses a whole-number step floored at 0, not the legacy 0.1 with no floor', () => {
    const html = renderToStaticMarkup(<ItemFormModal mode="add" locations={[]} categories={categories} onClose={() => {}} />);
    expect(quantityInputTag(html)).toContain('step="1"');
    expect(quantityInputTag(html)).toContain('min="0"');
  });
});
