import type { Item } from './api';

// Pure, no React/DOM — ports renderItems()'s filter predicate from public/index.html
// verbatim (including the barcode-search asymmetry: legacy lowercases only the search term,
// not the barcode; here both sides are lowercased, a harmless superset for real barcode data
// which is digits-only, and this stage's own test spec asks for it explicitly).

export type TabType = 'all' | 'location' | 'grocery' | 'ignored';

export interface Tab {
  type: TabType;
  id: number | null;
}

// Categories that aren't grocery-restockable in the normal sense, so items in them never
// appear in the Grocery List or Ignored Out-of-Stock tabs regardless of stock level.
const NON_GROCERY_CATEGORIES = ['Homemade', 'Dog Food'];

export function filterItems(items: Item[], tab: Tab, search: string): Item[] {
  const query = search.toLowerCase();
  return items.filter((item) => {
    if (query) {
      const nameMatch = item.name.toLowerCase().includes(query);
      const barcodeMatch = Boolean(item.barcode) && item.barcode!.toLowerCase().includes(query);
      if (!nameMatch && !barcodeMatch) return false;
    }

    switch (tab.type) {
      case 'all':
        return true;
      case 'location':
        return item.locations.some((l) => l.location_id === tab.id);
      case 'grocery':
        return (
          item.quantity <= item.reorder_threshold &&
          item.is_ignored_grocery === 0 &&
          !NON_GROCERY_CATEGORIES.includes(item.category_name ?? '')
        );
      case 'ignored':
        return item.is_ignored_grocery === 1 && !NON_GROCERY_CATEGORIES.includes(item.category_name ?? '');
      default:
        return true;
    }
  });
}
