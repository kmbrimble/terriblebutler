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
