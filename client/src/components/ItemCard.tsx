import { useRef } from 'react';
import type { Item } from '../lib/api';
import type { ViewMode } from '../lib/preferences';
import type { Tab } from '../lib/filterItems';
import { cardQuantity, cardIsOpen, openToggleTarget } from '../lib/cardQuantity';
import { locationLabel } from '../lib/locationLabel';
import { isTap } from '../lib/tapGesture';

const EDIT_ICON = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

// Stops a drag/scroll gesture that starts on a nested button from ever reaching the card's own
// tap-vs-scroll detection below: since the card only starts tracking a gesture on its own
// pointerdown, suppressing that event's bubbling here means the card never records a start
// point, so a later pointerup — even if it bubbles up — has nothing to compare against.
function stopPointerDown(e: React.PointerEvent) {
  e.stopPropagation();
}

export function ItemCard({
  item,
  viewMode,
  tab,
  onEdit,
  onOpenDetail,
  onAdjust,
  onOpenQtyModal,
  onToggleIgnore,
  onToggleOpen,
}: {
  item: Item;
  viewMode: ViewMode;
  tab: Tab;
  onEdit: (item: Item) => void;
  onOpenDetail: (item: Item) => void;
  onAdjust: (item: Item, action: 'add' | 'subtract') => void;
  onOpenQtyModal: (item: Item) => void;
  onToggleIgnore: (item: Item, status: 0 | 1) => void;
  onToggleOpen: (item: Item, locationId: number | null, isOpen: 0 | 1) => void;
}) {
  // Ref, not state — the pointerdown/pointerup pair happens well within one gesture and never
  // needs to trigger a re-render.
  const tapStart = useRef<{ x: number; y: number; time: number; pointerId: number } | null>(null);

  function handleCardPointerDown(e: React.PointerEvent) {
    tapStart.current = { x: e.clientX, y: e.clientY, time: Date.now(), pointerId: e.pointerId };
  }

  function handleCardPointerUp(e: React.PointerEvent) {
    const start = tapStart.current;
    tapStart.current = null;
    if (!start || start.pointerId !== e.pointerId) return;
    if (isTap(e.clientX - start.x, e.clientY - start.y, Date.now() - start.time)) {
      onOpenDetail(item);
    }
  }

  function handleCardPointerCancel() {
    tapStart.current = null;
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenDetail(item);
    }
  }

  const cardInteractionProps = {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `View details for ${item.name}`,
    onPointerDown: handleCardPointerDown,
    onPointerUp: handleCardPointerUp,
    onPointerCancel: handleCardPointerCancel,
    onKeyDown: handleCardKeyDown,
  };
  const locLabel = locationLabel(item);
  const qty = cardQuantity(item, tab);
  const isOpen = cardIsOpen(item, tab);
  const openTarget = openToggleTarget(item, tab);
  // Button visibility mirrors public/index.html exactly: driven by which tab is active, not by
  // reading item.is_ignored_grocery (which can be genuinely NULL on live rows despite its
  // DEFAULT 0 — see the live-DB audit in this stage's changelog entry).
  const isGrocery = tab.type === 'grocery';
  const isIgnored = tab.type === 'ignored';

  const qtyControls = (
    <div className="flex items-center bg-rimmy-black rounded border border-rimmy-border overflow-hidden h-full">
      <button
        type="button"
        data-testid="qty-minus-button"
        onPointerDown={stopPointerDown}
        onClick={(e) => {
          e.stopPropagation();
          onAdjust(item, 'subtract');
        }}
        className="w-8 h-full flex items-center justify-center bg-red-600 hover:bg-red-500 text-white text-[14px] font-bold"
      >
        -
      </button>
      <button
        type="button"
        data-testid="qty-display-button"
        onPointerDown={stopPointerDown}
        onClick={(e) => {
          e.stopPropagation();
          onOpenQtyModal(item);
        }}
        className={`w-10 h-full flex items-center justify-center bg-transparent font-bold text-[12px] leading-none ${isOpen ? 'text-red-500' : 'text-rimmy-text'}`}
      >
        {qty}
      </button>
      <button
        type="button"
        data-testid="qty-plus-button"
        onPointerDown={stopPointerDown}
        onClick={(e) => {
          e.stopPropagation();
          onAdjust(item, 'add');
        }}
        className="w-8 h-full flex items-center justify-center bg-green-600 hover:bg-green-500 text-white text-[14px] font-bold"
      >
        +
      </button>
    </div>
  );

  const openButton = openTarget !== undefined && (
    <button
      type="button"
      data-testid="open-toggle-button"
      aria-label={isOpen ? 'Mark closed' : 'Mark open'}
      onPointerDown={stopPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onToggleOpen(item, openTarget, isOpen ? 0 : 1);
      }}
      className={
        isOpen
          ? 'w-8 h-full flex items-center justify-center text-orange-500 border border-orange-500 rounded text-[9px] font-bold'
          : 'w-8 h-full flex items-center justify-center text-rimmy-textMuted hover:text-rimmy-orange border border-rimmy-border rounded text-[9px] font-bold'
      }
    >
      Open
    </button>
  );

  const editButton = (
    <button
      type="button"
      data-testid="edit-item-button"
      aria-label="Edit"
      onPointerDown={stopPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(item);
      }}
      className="w-8 h-full flex items-center justify-center text-rimmy-textMuted hover:text-rimmy-orange touch-target rounded border border-rimmy-border bg-rimmy-black"
    >
      {EDIT_ICON}
    </button>
  );

  const ignoreButton = (isGrocery || isIgnored) && (
    <button
      type="button"
      data-testid="ignore-toggle-button"
      onPointerDown={stopPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        onToggleIgnore(item, isGrocery ? 1 : 0);
      }}
      className={isGrocery ? 'ml-2 px-1 text-red-500 border border-red-500 rounded text-[9px]' : 'ml-2 px-1 text-green-500 border border-green-500 rounded text-[9px]'}
    >
      {isGrocery ? 'Ignore' : 'Restore'}
    </button>
  );

  if (viewMode === 'compact') {
    return (
      <div
        {...cardInteractionProps}
        data-testid="item-card"
        data-view-mode="compact"
        className="bg-rimmy-charcoal rounded border border-rimmy-border flex justify-between items-center px-3 py-1 h-[44px] shadow-sm"
      >
        <div className="flex-1 min-w-0 pr-2 flex flex-col justify-center">
          <h3 className="font-bold text-sm text-rimmy-orange truncate leading-none">{item.name}</h3>
          <p className="text-[11px] text-rimmy-textMuted truncate leading-tight mt-1">
            {locLabel ? `${locLabel} | ` : ''}
            {item.container_details}
            {ignoreButton}
          </p>
        </div>
        <div className="flex items-center shrink-0 h-[30px] gap-1">
          {editButton}
          {openButton}
          {qtyControls}
        </div>
      </div>
    );
  }

  return (
    <div
      {...cardInteractionProps}
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
          Last Price: ${(item.last_price || 0).toFixed(2)} | Lowest: ${(item.lowest_price || 0).toFixed(2)}
        </p>
        {ignoreButton}
      </div>
      <div className="flex w-full sm:w-auto justify-end gap-2">
        {editButton}
        {openButton}
        {qtyControls}
      </div>
    </div>
  );
}
