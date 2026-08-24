import { useEffect, useState } from 'react';
import { getItems, getLocations, getCategories, updateItemQuantity, setIgnoreGrocery, setItemOpen, type Item, type Location, type Category } from './api';
import { connectSocket } from './socket';
import type { Tab } from './filterItems';

// Extracted from ItemList.tsx so every restyled variant (see issue #37) shares one copy of the
// data-fetching/socket/mutation logic instead of reimplementing it per style.
export function useInventory() {
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  const refetchItems = () => getItems().then(setItems).catch(() => {});

  useEffect(() => {
    refetchItems();
    getLocations().then(setLocations).catch(() => {});
    getCategories().then(setCategories).catch(() => {});
  }, []);

  // All three events carry empty or ignored payloads by design (confirmed in server.js's
  // broadcastUpdate()) — every one is purely a refetch signal, mirroring public/index.html's
  // socket.on(...) handlers exactly. Calling connectSocket() here (idempotent) rather than
  // just reading the App-level socket avoids a mount-order race: child effects fire before
  // the parent's on the same commit, so App's own connectSocket() call may not have run yet.
  useEffect(() => {
    const socket = connectSocket();

    const refetchLocations = () => {
      getLocations().then(setLocations).catch(() => {});
      refetchItems();
    };
    const refetchCategories = () => {
      getCategories().then(setCategories).catch(() => {});
      refetchItems();
    };

    socket.on('inventory_updated', refetchItems);
    socket.on('locations_updated', refetchLocations);
    socket.on('categories_updated', refetchCategories);

    return () => {
      socket.off('inventory_updated', refetchItems);
      socket.off('locations_updated', refetchLocations);
      socket.off('categories_updated', refetchCategories);
    };
  }, []);

  // Ports quickAdjustQty(): a location tab targets that location directly (the whole point of
  // filtering to one); otherwise it's only unambiguous when the item has at most one location —
  // a multi-location item viewed outside a location tab returns the item so the caller can open
  // the set-quantity modal's location picker instead of guessing which location to adjust.
  function quickAdjust(item: Item, action: 'add' | 'subtract', tab: Tab): Item | null {
    if (tab.type === 'location') {
      updateItemQuantity(item.id, 1, action, tab.id).catch(() => {});
      return null;
    }
    if (item.locations.length > 1) {
      return item;
    }
    updateItemQuantity(item.id, 1, action).catch(() => {});
    return null;
  }

  function toggleIgnore(item: Item, status: 0 | 1) {
    setIgnoreGrocery(item.id, status).catch(() => {});
  }

  function toggleOpen(item: Item, locationId: number | null, isOpen: 0 | 1) {
    setItemOpen(item.id, isOpen, locationId).catch(() => {});
  }

  return { items, locations, categories, refetchItems, quickAdjust, toggleIgnore, toggleOpen };
}
