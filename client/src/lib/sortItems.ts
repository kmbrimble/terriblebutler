import type { Item } from './api';

// Pure, non-mutating, no React/DOM — ports renderItems()'s sort switch from
// public/index.html verbatim, including the tie-break (return 0 preserves relative order;
// Array.prototype.sort has been spec-guaranteed stable since ES2019).

export type SortBy = 'name' | 'created_at' | 'updated_at' | 'quantity' | 'category' | 'location';
export type SortDir = 'asc' | 'desc';

function sortKey(item: Item, sortBy: SortBy): string | number {
  switch (sortBy) {
    case 'created_at':
      return new Date(item.created_at).getTime();
    case 'updated_at':
      return new Date(item.updated_at).getTime();
    case 'quantity':
      return item.quantity || 0;
    case 'category':
      return (item.category_name || '').toLowerCase();
    case 'location':
      return (item.locations[0]?.location_name || '').toLowerCase();
    case 'name':
    default:
      return (item.name || '').toLowerCase();
  }
}

export function sortItems(items: Item[], sortBy: SortBy, sortDir: SortDir): Item[] {
  return [...items].sort((a, b) => {
    const valA = sortKey(a, sortBy);
    const valB = sortKey(b, sortBy);
    if (valA < valB) return sortDir === 'asc' ? -1 : 1;
    if (valA > valB) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}
