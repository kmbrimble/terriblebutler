import { useEffect, useMemo, useState } from 'react';
import { getItems, getLocations, getCategories, updateItemQuantity, setIgnoreGrocery, setItemOpen, type Item, type Location, type Category } from '../lib/api';
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
import { splitAvailability } from '../lib/cardQuantity';
import { TabBar } from './TabBar';
import { SearchInput } from './SearchInput';
import { SortControl } from './SortControl';
import { ViewModeToggle } from './ViewModeToggle';
import { ItemCard } from './ItemCard';
import { Header } from './Header';
import { ItemFormModal } from './ItemFormModal';
import { DeductModal } from './DeductModal';
import { QtyModal } from './QtyModal';
import { ItemDetailModal } from './ItemDetailModal';
import { InvoiceImportModal, ACTIVE_IMPORT_KEY } from './InvoiceImportModal';
import { ManageCategoriesModal } from './ManageCategoriesModal';
import { ManageLocationsModal } from './ManageLocationsModal';
import { Toast } from './Toast';

export function ItemList() {
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [tab, setTab] = useState<Tab>({ type: 'all', id: null });
  const [search, setSearch] = useState('');
  const [sortBy, setSortByState] = useState(getSortBy);
  const [sortDir, setSortDirState] = useState(getSortDir);
  const [viewMode, setViewModeState] = useState(getViewMode);

  const [addOpen, setAddOpen] = useState(false);
  const [deductOpen, setDeductOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [qtyModalItem, setQtyModalItem] = useState<Item | null>(null);
  const [detailItem, setDetailItem] = useState<Item | null>(null);
  const [invoiceImportOpen, setInvoiceImportOpen] = useState(false);
  const [manageCategoriesOpen, setManageCategoriesOpen] = useState(false);
  const [manageLocationsOpen, setManageLocationsOpen] = useState(false);

  useEffect(() => {
    getItems().then(setItems).catch(() => {});
    getLocations().then(setLocations).catch(() => {});
    getCategories().then(setCategories).catch(() => {});
  }, []);

  // Ports resumeActiveInvoiceImport(): if the tab closed or the app restarted mid-review, land
  // straight back on the same review screen on next load rather than requiring the user to
  // remember an import was in progress and re-open it manually. InvoiceImportModal's own mount
  // effect does the actual fetch/validation (and clears the key if the import turns out to
  // already be committed) — this just decides whether to mount it in the first place.
  useEffect(() => {
    if (localStorage.getItem(ACTIVE_IMPORT_KEY)) setInvoiceImportOpen(true);
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
  const { available, unavailable } = useMemo(() => splitAvailability(visibleItems, tab), [visibleItems, tab]);

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

  // Ports quickAdjustQty(): a location tab targets that location directly (the whole point of
  // filtering to one); otherwise it's only unambiguous when the item has at most one location —
  // a multi-location item viewed outside a location tab opens the set-quantity modal's location
  // picker instead of guessing which location to adjust.
  function handleQuickAdjust(item: Item, action: 'add' | 'subtract') {
    if (tab.type === 'location') {
      updateItemQuantity(item.id, 1, action, tab.id).catch(() => {});
      return;
    }
    if (item.locations.length > 1) {
      setQtyModalItem(item);
      return;
    }
    updateItemQuantity(item.id, 1, action).catch(() => {});
  }

  function handleToggleIgnore(item: Item, status: 0 | 1) {
    setIgnoreGrocery(item.id, status).catch(() => {});
  }

  function handleToggleOpen(item: Item, locationId: number | null, isOpen: 0 | 1) {
    setItemOpen(item.id, isOpen, locationId).catch(() => {});
  }

  return (
    <div className="flex flex-col">
      <Header
        onOpenAdd={() => setAddOpen(true)}
        onOpenDeduct={() => setDeductOpen(true)}
        onOpenInvoiceImport={() => setInvoiceImportOpen(true)}
        onOpenManageCategories={() => setManageCategoriesOpen(true)}
        onOpenManageLocations={() => setManageLocationsOpen(true)}
      />
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
          <>
            {available.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                viewMode={viewMode}
                tab={tab}
                onEdit={setEditingItem}
                onOpenDetail={setDetailItem}
                onAdjust={handleQuickAdjust}
                onOpenQtyModal={setQtyModalItem}
                onToggleIgnore={handleToggleIgnore}
                onToggleOpen={handleToggleOpen}
              />
            ))}
            {unavailable.length > 0 && (
              <>
                <h2 data-testid="unavailable-heading" className="text-sm font-bold text-rimmy-textMuted uppercase tracking-wide pt-2">
                  Unavailable
                </h2>
                {unavailable.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    viewMode={viewMode}
                    tab={tab}
                    onEdit={setEditingItem}
                    onOpenDetail={setDetailItem}
                    onAdjust={handleQuickAdjust}
                    onOpenQtyModal={setQtyModalItem}
                    onToggleIgnore={handleToggleIgnore}
                onToggleOpen={handleToggleOpen}
                  />
                ))}
              </>
            )}
          </>
        )}
      </main>

      {(addOpen || editingItem) && (
        <ItemFormModal
          mode={editingItem ? 'edit' : 'add'}
          item={editingItem ?? undefined}
          locations={locations}
          categories={categories}
          onClose={() => {
            setAddOpen(false);
            setEditingItem(null);
          }}
        />
      )}
      {deductOpen && <DeductModal items={items} onClose={() => setDeductOpen(false)} />}
      {qtyModalItem && <QtyModal item={qtyModalItem} onClose={() => setQtyModalItem(null)} />}
      {detailItem && <ItemDetailModal item={detailItem} onClose={() => setDetailItem(null)} />}
      {invoiceImportOpen && (
        <InvoiceImportModal
          categories={categories}
          locations={locations}
          onClose={() => setInvoiceImportOpen(false)}
          onCommitted={() => {
            setInvoiceImportOpen(false);
            getItems().then(setItems).catch(() => {});
          }}
        />
      )}
      {manageCategoriesOpen && <ManageCategoriesModal categories={categories} onClose={() => setManageCategoriesOpen(false)} />}
      {manageLocationsOpen && <ManageLocationsModal locations={locations} onClose={() => setManageLocationsOpen(false)} />}
      <Toast />
    </div>
  );
}
