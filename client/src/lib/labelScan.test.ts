import { describe, expect, it } from 'vitest';
import { deriveLabelScanUpdate } from './labelScan';
import type { LabelScanResult } from './api';

function makeResult(overrides: Partial<LabelScanResult> = {}): LabelScanResult {
  return {
    name: '',
    container_details: '',
    category_id: null,
    location_id: null,
    suggested_category_name: null,
    similar_category: null,
    suggested_location_name: null,
    similar_location: null,
    ...overrides,
  };
}

describe('deriveLabelScanUpdate', () => {
  it('applies name/container_details/category_id/location_id directly on an exact match, no suggestion', () => {
    const update = deriveLabelScanUpdate(makeResult({ name: 'Baked Beans', container_details: '420g', category_id: 5, location_id: 2 }));
    expect(update.name).toBe('Baked Beans');
    expect(update.container_details).toBe('420g');
    expect(update.category_id).toBe(5);
    expect(update.location_id).toBe(2);
    expect(update.categorySuggestion).toBeNull();
    expect(update.locationSuggestion).toBeNull();
  });

  it('does not overwrite name/container_details when the server returns empty strings', () => {
    const update = deriveLabelScanUpdate(makeResult({ name: '', container_details: '' }));
    expect(update.name).toBeUndefined();
    expect(update.container_details).toBeUndefined();
  });

  it('leaves category_id/location_id unset (not 0) when the server returns null', () => {
    const update = deriveLabelScanUpdate(makeResult({ category_id: null, location_id: null }));
    expect(update.category_id).toBeUndefined();
    expect(update.location_id).toBeUndefined();
  });

  it('surfaces a category suggestion with no similar match defaulting to "add as new"', () => {
    const update = deriveLabelScanUpdate(makeResult({ suggested_category_name: 'Snacks', similar_category: null }));
    expect(update.categorySuggestion).toEqual({ suggestedName: 'Snacks', similar: null });
  });

  it('surfaces a category suggestion pre-selecting the closest fuzzy match', () => {
    const update = deriveLabelScanUpdate(
      makeResult({ suggested_category_name: 'Snaks', similar_category: { id: 7, name: 'Snacks' } })
    );
    expect(update.categorySuggestion).toEqual({ suggestedName: 'Snaks', similar: { id: 7, name: 'Snacks' } });
  });

  it('handles category and location suggestions independently and simultaneously', () => {
    const update = deriveLabelScanUpdate(
      makeResult({
        suggested_category_name: 'Snacks',
        similar_category: null,
        suggested_location_name: 'Pantry',
        similar_location: { id: 3, name: 'Pantry Shelf' },
      })
    );
    expect(update.categorySuggestion).toEqual({ suggestedName: 'Snacks', similar: null });
    expect(update.locationSuggestion).toEqual({ suggestedName: 'Pantry', similar: { id: 3, name: 'Pantry Shelf' } });
  });
});
