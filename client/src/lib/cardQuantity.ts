import type { Item } from './api';
import type { Tab } from './filterItems';

// Pure, no React/DOM — ports public/index.html's cardQuantity() verbatim: inside a location
// tab, an item card shows that location's own quantity (0 if the item isn't stocked there);
// otherwise it shows the item's total across all locations.
export function cardQuantity(item: Item, tab: Tab): number {
  if (tab.type === 'location') {
    const here = item.locations.find((l) => l.location_id === tab.id);
    return here ? here.quantity : 0;
  }
  return item.quantity;
}

// Splits an already-sorted, already-filtered items list into in-stock ("available") and
// out-of-stock ("unavailable") sections for the "all"/"location" tabs, preserving the given
// order within each section. The grocery and ignored tabs already have their own
// threshold/ignored-flag selection logic — every item there is grocery-relevant by
// definition, so imposing a qty-based split on top would be redundant, not a genuine section.
export function splitAvailability(items: Item[], tab: Tab): { available: Item[]; unavailable: Item[] } {
  if (tab.type !== 'all' && tab.type !== 'location') {
    return { available: items, unavailable: [] };
  }
  const available: Item[] = [];
  const unavailable: Item[] = [];
  for (const item of items) {
    (cardQuantity(item, tab) > 0 ? available : unavailable).push(item);
  }
  return { available, unavailable };
}
