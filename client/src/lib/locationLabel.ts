import type { Item } from './api';

// An item can carry a stale zero-stock location entry alongside its real one (stock moved out
// but the row wasn't deleted), so picking locations[0] blindly can surface the empty location
// instead of the one that actually has stock. Prefer the single location with stock when
// there's exactly one; otherwise fall back to the original behaviour ("N locations" summary
// when there's more than one entry, or the lone entry's name — even at 0 — when there's only one).
export function locationLabel(item: Item): string {
  const withStock = item.locations.filter((l) => l.quantity > 0);
  if (withStock.length === 1) return withStock[0].location_name || '';
  if (item.locations.length > 1) return `${item.locations.length} locations`;
  return item.locations[0]?.location_name || '';
}
