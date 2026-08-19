import { useEffect, useMemo, useState } from 'react';
import { getItems, getLocations, getCategories, type Item, type Location, type Category } from '../lib/api';
import { connectSocket } from '../lib/socket';
import {
  getViewMode,
  setViewMode as persistViewMode,
  getSortBy,
  setSortBy as persistSortBy,
  getSortDir,
  setSortDir as persistSortDir,
} from '../lib/preferences';
import { filterItems, type Tab } from '../lib/filterItems';
import { sortItems } from '../lib/sortItems';
import { TabBar } from './TabBar';
import { SearchInput } from './SearchInput';
import { SortControl } from './SortControl';
import { ViewModeToggle } from './ViewModeToggle';
import { ItemCard } from './ItemCard';

export function ItemList() {
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [, setCategories] = useState<Category[]>([]);
  const [tab, setTab] = useState<Tab>({ type: 'all', id: null });
  const [search, setSearch] = useState('');
  const [sortBy, setSortByState] = useState(getSortBy);
  const [sortDir, setSortDirState] = useState(getSortDir);
  const [viewMode, setViewModeState] = useState(getViewMode);

  useEffect(() => {
    getItems().then(setItems).catch(() => {});
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

    const refetchItems = () => getItems().then(setItems).catch(() => {});
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

  // Mirrors renderTabs(): if the active tab's location was deleted, fall back to All Inventory.
  useEffect(() => {
    if (tab.type === 'location' && !locations.some((loc) => loc.id === tab.id)) {
      setTab({ type: 'all', id: null });
    }
  }, [locations, tab]);

  const visibleItems = useMemo(() => sortItems(filterItems(items, tab, search), sortBy, sortDir), [items, tab, search, sortBy, sortDir]);

  function handleSortByChange(next: typeof sortBy) {
    setSortByState(next);
    persistSortBy(next);
  }

  function handleToggleDir() {
    const next = sortDir === 'asc' ? 'desc' : 'asc';
    setSortDirState(next);
    persistSortDir(next);
  }

  function handleToggleViewMode() {
    const next = viewMode === 'compact' ? 'expanded' : 'compact';
    setViewModeState(next);
    persistViewMode(next);
  }

  return (
    <div className="flex flex-col">
      <TabBar locations={locations} activeTab={tab} onSelect={setTab} />
      <div className="p-4 flex flex-col gap-3">
        <SearchInput value={search} onChange={setSearch} />
        <div className="flex justify-between items-center gap-2">
          <SortControl sortBy={sortBy} sortDir={sortDir} onSortByChange={handleSortByChange} onToggleDir={handleToggleDir} />
          <ViewModeToggle viewMode={viewMode} onToggle={handleToggleViewMode} />
        </div>
      </div>
      <main data-testid="item-list" className="p-4 space-y-4">
        {visibleItems.length === 0 ? (
          <p data-testid="empty-state" className="text-center text-rimmy-textMuted mt-8 font-bold">
            No items found.
          </p>
        ) : (
          visibleItems.map((item) => <ItemCard key={item.id} item={item} viewMode={viewMode} />)
        )}
      </main>
    </div>
  );
}
