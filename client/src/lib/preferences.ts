// Plain TypeScript, no React or DOM-library imports — same reasoning as api.ts. Wraps the
// SAME localStorage keys the legacy front end uses, so switching between / and /v2 during the
// rewrite doesn't reset a user's preference.

export type ViewMode = 'compact' | 'expanded';
export type SortBy = 'name' | 'created_at' | 'updated_at' | 'quantity' | 'category' | 'location';
export type SortDir = 'asc' | 'desc';

const VIEW_MODE_KEY = 'tb_view_mode';
const SORT_BY_KEY = 'tb_sort_by';
const SORT_DIR_KEY = 'tb_sort_dir';

export function getViewMode(): ViewMode {
  return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode | null) || 'compact';
}

export function setViewMode(mode: ViewMode): void {
  localStorage.setItem(VIEW_MODE_KEY, mode);
}

export function getSortBy(): SortBy {
  return (localStorage.getItem(SORT_BY_KEY) as SortBy | null) || 'name';
}

export function setSortBy(sortBy: SortBy): void {
  localStorage.setItem(SORT_BY_KEY, sortBy);
}

export function getSortDir(): SortDir {
  return (localStorage.getItem(SORT_DIR_KEY) as SortDir | null) || 'asc';
}

export function setSortDir(dir: SortDir): void {
  localStorage.setItem(SORT_DIR_KEY, dir);
}
