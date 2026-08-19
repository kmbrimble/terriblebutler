import type { SortBy, SortDir } from '../lib/preferences';

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'name', label: 'Alphabetical' },
  { value: 'created_at', label: 'Date Added' },
  { value: 'updated_at', label: 'Date Updated' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'category', label: 'Category' },
  { value: 'location', label: 'Location' },
];

export function SortControl({
  sortBy,
  sortDir,
  onSortByChange,
  onToggleDir,
}: {
  sortBy: SortBy;
  sortDir: SortDir;
  onSortByChange: (sortBy: SortBy) => void;
  onToggleDir: () => void;
}) {
  return (
    <div className="flex gap-2">
      <select
        data-testid="sort-select"
        value={sortBy}
        onChange={(e) => onSortByChange(e.target.value as SortBy)}
        className="flex-1 bg-rimmy-black border border-rimmy-border focus:border-rimmy-orange outline-none rounded p-2 text-rimmy-text transition-colors touch-target text-sm"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="sort-dir-button"
        onClick={onToggleDir}
        className="w-16 bg-rimmy-black border border-rimmy-border hover:border-rimmy-orange text-rimmy-orange font-bold rounded transition-colors touch-target text-sm"
      >
        {sortDir.toUpperCase()}
      </button>
    </div>
  );
}
