import type { ViewMode } from '../lib/preferences';

export function ViewModeToggle({ viewMode, onToggle }: { viewMode: ViewMode; onToggle: () => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" data-testid="view-mode-toggle" checked={viewMode === 'expanded'} onChange={onToggle} className="w-5 h-5 accent-rimmy-purple" />
      <span className="text-rimmy-text font-bold text-sm">Expanded View</span>
    </label>
  );
}
