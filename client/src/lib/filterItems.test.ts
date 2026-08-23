import { describe, expect, it } from 'vitest';
import { filterItems } from './filterItems';
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

describe('filterItems', () => {
  it('the "all" tab returns every item regardless of location', () => {
    const items = [makeItem({ id: 1 }), makeItem({ id: 2, locations: [{ location_id: 5, location_name: 'Pantry', quantity: 2 }] })];
    const result = filterItems(items, { type: 'all', id: null }, '');
    expect(result).toHaveLength(2);
  });

  it('a location tab only returns items with a matching entry in item.locations[]', () => {
    const inLocation = makeItem({ id: 1, locations: [{ location_id: 5, location_name: 'Pantry', quantity: 2 }] });
    const elsewhere = makeItem({ id: 2, locations: [{ location_id: 6, location_name: 'Garage', quantity: 1 }] });
    const noLocation = makeItem({ id: 3, locations: [] });
    const result = filterItems([inLocation, elsewhere, noLocation], { type: 'location', id: 5 }, '');
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('the grocery tab returns items at or below their reorder threshold, excluding ignored ones', () => {
    const lowStock = makeItem({ id: 1, quantity: 1, reorder_threshold: 2, is_ignored_grocery: 0 });
    const wellStocked = makeItem({ id: 2, quantity: 5, reorder_threshold: 2, is_ignored_grocery: 0 });
    const ignoredLowStock = makeItem({ id: 3, quantity: 0, reorder_threshold: 2, is_ignored_grocery: 1 });
    const exactlyAtThreshold = makeItem({ id: 4, quantity: 2, reorder_threshold: 2, is_ignored_grocery: 0 });
    const result = filterItems([lowStock, wellStocked, ignoredLowStock, exactlyAtThreshold], { type: 'grocery', id: null }, '');
    expect(result.map((i) => i.id).sort()).toEqual([1, 4]);
  });

  it('the ignored tab returns only items flagged is_ignored_grocery', () => {
    const ignored = makeItem({ id: 1, is_ignored_grocery: 1 });
    const notIgnored = makeItem({ id: 2, is_ignored_grocery: 0 });
    const result = filterItems([ignored, notIgnored], { type: 'ignored', id: null }, '');
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('the grocery tab excludes Homemade and Dog Food items regardless of stock level', () => {
    const lowHomemade = makeItem({ id: 1, quantity: 0, reorder_threshold: 2, category_name: 'Homemade' });
    const lowDogFood = makeItem({ id: 2, quantity: 0, reorder_threshold: 2, category_name: 'Dog Food' });
    const lowOther = makeItem({ id: 3, quantity: 0, reorder_threshold: 2, category_name: 'Pantry' });
    const result = filterItems([lowHomemade, lowDogFood, lowOther], { type: 'grocery', id: null }, '');
    expect(result.map((i) => i.id)).toEqual([3]);
  });

  it('the ignored tab excludes Homemade and Dog Food items even when flagged ignored', () => {
    const homemade = makeItem({ id: 1, is_ignored_grocery: 1, category_name: 'Homemade' });
    const dogFood = makeItem({ id: 2, is_ignored_grocery: 1, category_name: 'Dog Food' });
    const other = makeItem({ id: 3, is_ignored_grocery: 1, category_name: 'Pantry' });
    const result = filterItems([homemade, dogFood, other], { type: 'ignored', id: null }, '');
    expect(result.map((i) => i.id)).toEqual([3]);
  });

  it('matches Homemade/Dog Food regardless of case or surrounding whitespace', () => {
    const lowerCase = makeItem({ id: 1, quantity: 0, reorder_threshold: 2, category_name: 'homemade' });
    const shoutCase = makeItem({ id: 2, quantity: 0, reorder_threshold: 2, category_name: 'DOG FOOD' });
    const padded = makeItem({ id: 3, quantity: 0, reorder_threshold: 2, category_name: ' Homemade ' });
    const result = filterItems([lowerCase, shoutCase, padded], { type: 'grocery', id: null }, '');
    expect(result).toEqual([]);
  });

  it('the "all" tab still shows Homemade and Dog Food items', () => {
    const homemade = makeItem({ id: 1, category_name: 'Homemade' });
    const result = filterItems([homemade], { type: 'all', id: null }, '');
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('search matches the item name case-insensitively', () => {
    const items = [makeItem({ id: 1, name: 'Chicken Stock' }), makeItem({ id: 2, name: 'Beef Stock' })];
    const result = filterItems(items, { type: 'all', id: null }, 'CHICKEN');
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('search matches the barcode case-insensitively', () => {
    const items = [makeItem({ id: 1, barcode: 'ABC123' }), makeItem({ id: 2, barcode: 'XYZ789' })];
    const result = filterItems(items, { type: 'all', id: null }, 'abc');
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('search combines with the active tab rather than replacing it', () => {
    const matchInLocation = makeItem({ id: 1, name: 'Chicken Stock', locations: [{ location_id: 5, location_name: 'Pantry', quantity: 1 }] });
    const matchElsewhere = makeItem({ id: 2, name: 'Chicken Broth', locations: [{ location_id: 6, location_name: 'Garage', quantity: 1 }] });
    const noMatchInLocation = makeItem({ id: 3, name: 'Beef Stock', locations: [{ location_id: 5, location_name: 'Pantry', quantity: 1 }] });
    const result = filterItems([matchInLocation, matchElsewhere, noMatchInLocation], { type: 'location', id: 5 }, 'chicken');
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('an item with no barcode is not matched by a non-empty search on name mismatch', () => {
    const items = [makeItem({ id: 1, name: 'Beef Stock', barcode: null })];
    const result = filterItems(items, { type: 'all', id: null }, 'chicken');
    expect(result).toHaveLength(0);
  });
});
