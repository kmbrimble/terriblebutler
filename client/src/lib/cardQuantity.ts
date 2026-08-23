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
// Mirrors cardQuantity()'s tab-scoping: inside a location tab, whether THAT location's pack is
// open; otherwise whether ANY location has an open pack (the aggregate view can't point at one
// specific location, so "there's an open item somewhere" is the closest honest signal).
export function cardIsOpen(item: Item, tab: Tab): boolean {
  if (tab.type === 'location') {
    const here = item.locations.find((l) => l.location_id === tab.id);
    return Boolean(here?.is_open);
  }
  return item.locations.some((l) => Boolean(l.is_open));
}

// Resolves which location the open-toggle button should act on: the active location tab, or
// the item's one-and-only location when unambiguous (including the unassigned/null bucket for
// an item with no locations at all). Returns undefined — "hide the toggle" — for a
// multi-location item viewed outside a location tab, the same ambiguity boundary the quick +/-
// buttons already respect (ItemList.tsx's handleQuickAdjust) rather than guessing which
// location's pack to mark open.
export function openToggleTarget(item: Item, tab: Tab): number | null | undefined {
  if (tab.type === 'location') return tab.id;
  if (item.locations.length === 0) return null;
  if (item.locations.length === 1) return item.locations[0].location_id;
  return undefined;
}

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
