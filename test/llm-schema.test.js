import { describe, it, expect } from 'vitest';
import { validateLabelResult, validateInvoiceItems } from '../llm-schema.js';

describe('validateLabelResult', () => {
  it('passes through a well-formed response, trimmed', () => {
    const result = validateLabelResult({
      name: '  Heinz Baked Beans  ',
      container_details: ' 420g ',
      category_name: 'Tinned',
      location_name: 'Pantry',
    });
    expect(result).toEqual({
      name: 'Heinz Baked Beans',
      container_details: '420g',
      category_name: 'Tinned',
      location_name: 'Pantry',
      errors: [],
    });
  });

  it('joins an object container_details into a string (observed LLM quirk)', () => {
    const result = validateLabelResult({ name: 'X', container_details: { weight: '180', unit: 'g' } });
    expect(result.container_details).toBe('180g');
  });

  it('falls back to safe empty defaults when the response is not an object', () => {
    for (const bad of [null, 'a string', 42, ['array']]) {
      const result = validateLabelResult(bad);
      expect(result.name).toBe('');
      expect(result.container_details).toBe('');
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('defaults missing fields to empty strings but flags them as a schema mismatch', () => {
    const result = validateLabelResult({});
    expect(result).toEqual({
      name: '',
      container_details: '',
      category_name: '',
      location_name: '',
      errors: [
        'schema mismatch: missing or empty "name"',
        'schema mismatch: missing or empty "category_name"',
        'schema mismatch: missing or empty "location_name"',
      ],
    });
  });

  it('ignores non-string fields rather than passing them through, and flags them as a schema mismatch', () => {
    const result = validateLabelResult({ name: 12345, category_name: { nested: true }, location_name: 'Pantry' });
    expect(result.name).toBe('');
    expect(result.category_name).toBe('');
    expect(result.errors).toEqual([
      'schema mismatch: missing or empty "name"',
      'schema mismatch: missing or empty "category_name"',
    ]);
  });

  it('flags a completely hallucinated, off-schema response rather than silently accepting it', () => {
    // Observed real behaviour: the model ignores the requested schema entirely and
    // returns unrelated keys. This is valid JSON and a valid object, so it must not
    // pass validation silently just because the top-level shape check succeeds.
    const result = validateLabelResult({ 'A images': 1, 'A descriptions': 'A can on a table.' });
    expect(result.name).toBe('');
    expect(result.category_name).toBe('');
    expect(result.location_name).toBe('');
    expect(result.errors).toEqual([
      'schema mismatch: missing or empty "name"',
      'schema mismatch: missing or empty "category_name"',
      'schema mismatch: missing or empty "location_name"',
    ]);
  });

  it('does not flag container_details as a schema mismatch when blank — it is legitimately optional', () => {
    const result = validateLabelResult({ name: 'Heinz Baked Beans', category_name: 'Tinned', location_name: 'Pantry' });
    expect(result.container_details).toBe('');
    expect(result.errors).toEqual([]);
  });
});

describe('validateInvoiceItems', () => {
  it('accepts a bare array of well-formed items', () => {
    const { items, errors } = validateInvoiceItems([
      { name: 'Milk 2L', quantity: 2, price: 4.5, vendor: 'Coles', container_details: '2L' },
    ]);
    expect(errors).toEqual([]);
    expect(items).toEqual([{ name: 'Milk 2L', container_details: '2L', quantity: 2, price: 4.5, vendor: 'Coles', barcode: null }]);
  });

  it('unwraps an { items: [...] } envelope', () => {
    const { items } = validateInvoiceItems({ items: [{ name: 'Bread', quantity: 1, price: 3 }] });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Bread');
  });

  it('drops an item missing a name', () => {
    const { items, errors } = validateInvoiceItems([{ quantity: 1, price: 1 }]);
    expect(items).toEqual([]);
    expect(errors[0]).toMatch(/missing or invalid name/);
  });

  it('drops an item with a non-numeric or negative quantity', () => {
    const { items, errors } = validateInvoiceItems([
      { name: 'A', quantity: 'two', price: 1 },
      { name: 'B', quantity: -1, price: 1 },
      { name: 'C', quantity: null, price: 1 },
    ]);
    expect(items).toEqual([]);
    expect(errors).toHaveLength(3);
  });

  it('defaults an invalid price to 0 rather than dropping the item', () => {
    const { items, errors } = validateInvoiceItems([{ name: 'A', quantity: 1, price: 'free' }]);
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(0);
    expect(errors).toEqual([]);
  });

  it('returns an empty result for completely malformed input instead of throwing', () => {
    for (const bad of [null, 'a string', 42, { foo: 'bar' }, [null, 'x', 5]]) {
      const { items, errors } = validateInvoiceItems(bad);
      expect(Array.isArray(items)).toBe(true);
      expect(items.every((i) => typeof i.name === 'string')).toBe(true);
      expect(Array.isArray(errors)).toBe(true);
    }
  });
});
