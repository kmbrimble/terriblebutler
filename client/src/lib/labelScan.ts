import type { LabelScanResult } from './api';

// Ports applyLabelScanResult()/renderSuggestBlock() from public/index.html. A suggestion is
// shown whenever the server offers a suggested name (i.e. nothing matched exactly); `similar`
// pre-selects the closest fuzzy match, defaulting to "add as new" when there isn't one.
export interface SuggestionState {
  suggestedName: string;
  similar: { id: number; name: string } | null;
}

export interface LabelScanUpdate {
  name?: string;
  container_details?: string;
  category_id?: number;
  location_id?: number;
  categorySuggestion: SuggestionState | null;
  locationSuggestion: SuggestionState | null;
}

function suggestion(name: string | null, similar: { id: number; name: string } | null): SuggestionState | null {
  return name ? { suggestedName: name, similar } : null;
}

export function deriveLabelScanUpdate(data: LabelScanResult): LabelScanUpdate {
  const update: LabelScanUpdate = {
    categorySuggestion: suggestion(data.suggested_category_name, data.similar_category),
    locationSuggestion: suggestion(data.suggested_location_name, data.similar_location),
  };
  if (data.name) update.name = data.name;
  if (data.container_details) update.container_details = data.container_details;
  if (data.category_id !== undefined && data.category_id !== null) update.category_id = data.category_id;
  if (data.location_id !== undefined && data.location_id !== null) update.location_id = data.location_id;
  return update;
}
