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
        return item.quantity <= item.reorder_threshold && item.is_ignored_grocery === 0;
      case 'ignored':
        return item.is_ignored_grocery === 1;
      default:
        return true;
    }
  });
}
