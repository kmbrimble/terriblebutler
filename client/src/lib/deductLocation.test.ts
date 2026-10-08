import { describe, expect, it } from 'vitest';
import { UNASSIGNED, defaultDeductChoice, deductLocationId } from './deductLocation';
import type { ItemLocation } from './api';

const loc = (location_id: number | null, quantity: number): ItemLocation => ({ location_id, location_name: null, quantity });

describe('defaultDeductChoice', () => {
  it('preselects the only location with stock', () => {
    expect(defaultDeductChoice([loc(1, 0), loc(2, 3)])).toBe('2');
  });
  it('preselects the unassigned bucket when it is the only one with stock', () => {
    expect(defaultDeductChoice([loc(1, 0), loc(null, 3)])).toBe(UNASSIGNED);
  });
  it('leaves the choice empty when several locations have stock', () => {
    expect(defaultDeductChoice([loc(1, 2), loc(2, 3)])).toBe('');
  });
  it('leaves the choice empty when nothing has stock', () => {
    expect(defaultDeductChoice([loc(1, 0), loc(2, 0)])).toBe('');
  });
});

describe('deductLocationId', () => {
  it('maps the unassigned sentinel to null and ids to numbers', () => {
    expect(deductLocationId(UNASSIGNED)).toBeNull();
    expect(deductLocationId('7')).toBe(7);
  });
});
