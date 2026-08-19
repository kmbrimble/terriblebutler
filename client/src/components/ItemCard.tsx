import type { Item } from '../lib/api';
import type { ViewMode } from '../lib/preferences';

// Read-only this stage — no add/edit/deduct/scan/modal UI (that's later-stage work).
export function ItemCard({ item, viewMode }: { item: Item; viewMode: ViewMode }) {
  const locLabel = item.locations.length > 1 ? `${item.locations.length} locations` : item.locations[0]?.location_name || '';

  if (viewMode === 'compact') {
    return (
      <div
        data-testid="item-card"
        data-view-mode="compact"
        className="bg-rimmy-charcoal rounded border border-rimmy-border flex justify-between items-center px-3 py-1 h-[44px] shadow-sm"
      >
        <div className="flex-1 min-w-0 pr-2 flex flex-col justify-center">
          <h3 className="font-bold text-sm text-rimmy-orange truncate leading-none">{item.name}</h3>
          <p className="text-[11px] text-rimmy-textMuted truncate leading-tight mt-1">
            {locLabel ? `${locLabel} | ` : ''}
            {item.container_details}
          </p>
        </div>
        <div className="shrink-0 text-rimmy-text font-bold text-[12px]">{item.quantity}</div>
      </div>
    );
  }

  return (
    <div
      data-testid="item-card"
      data-view-mode="expanded"
      className="bg-rimmy-charcoal rounded-lg shadow-lg border border-rimmy-border p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center"
    >
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-lg text-rimmy-orange truncate">{item.name}</h3>
        <p className="text-sm text-rimmy-textMuted truncate">
          {locLabel ? `${locLabel} | ` : ''}
          {item.category_name || 'No Category'}
        </p>
        <p className="text-sm text-rimmy-textMuted truncate">{item.container_details}</p>
        <p className="text-sm text-rimmy-text font-semibold mt-1">
          Last Price: ${item.last_price.toFixed(2)} | Lowest: ${item.lowest_price.toFixed(2)}
        </p>
      </div>
      <div className="shrink-0 text-rimmy-text font-bold text-lg">{item.quantity}</div>
    </div>
  );
}
