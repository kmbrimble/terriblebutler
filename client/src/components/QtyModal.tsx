import { useState } from 'react';
import { updateItemQuantity, setItemOpen, moveItemLocation } from '../lib/api';
import type { Item, Location } from '../lib/api';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';
import { showToast } from '../lib/toast';

// Ports openQtyModal()/submitManualQty() from public/index.html: always sets an absolute
// quantity (never a delta), with a location picker only when the item has stock in more than
// one location. `initialLocationId` lets a caller (the item-detail view's per-location "edit"
// button) pre-select a specific row instead of defaulting to the first location.
export function QtyModal({
  item,
  locations,
  initialLocationId,
  onClose,
}: {
  item: Item;
  locations: Location[];
  initialLocationId?: number | null;
  onClose: () => void;
}) {
  useLockBodyScroll();
  const multiLocation = item.locations.length > 1;
  const initialLocation =
    (multiLocation && initialLocationId !== undefined && item.locations.find((l) => l.location_id === initialLocationId)) ||
    item.locations[0];
  const [locationId, setLocationId] = useState(() => String(initialLocation?.location_id ?? ''));
  const [amount, setAmount] = useState(() => {
    if (multiLocation) return String(initialLocation?.quantity ?? 0);
    return String(item.quantity);
  });
  // fixes #35: the card's own Open button hides itself for a multi-location item viewed outside
  // a location tab (openToggleTarget in cardQuantity.ts) since it can't guess which location's
  // pack to mark — this modal already resolves that ambiguity via the location picker below, so
  // it's the natural place to still offer the toggle for exactly that case.
  const [isOpen, setIsOpen] = useState(() => Boolean(initialLocation?.is_open));

  const sourceLocationId = locationId ? Number(locationId) : null;
  const moveDestinations = locations.filter((l) => l.id !== sourceLocationId);
  const [moveToLocationId, setMoveToLocationId] = useState(() => String(moveDestinations[0]?.id ?? ''));
  const [moveAmount, setMoveAmount] = useState(() => amount);
  const [moving, setMoving] = useState(false);

  function handleLocationChange(value: string) {
    setLocationId(value);
    const loc = item.locations.find((l) => String(l.location_id ?? '') === value);
    setAmount(String(loc ? loc.quantity : 0));
    setMoveAmount(String(loc ? loc.quantity : 0));
    setIsOpen(Boolean(loc?.is_open));
    const newSourceId = value ? Number(value) : null;
    setMoveToLocationId(String(locations.find((l) => l.id !== newSourceId)?.id ?? ''));
  }

  async function handleMove() {
    const val = parseFloat(moveAmount);
    if (isNaN(val) || val <= 0 || !moveToLocationId) return;
    setMoving(true);
    try {
      await moveItemLocation(item.id, val, multiLocation ? sourceLocationId : undefined, Number(moveToLocationId));
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to move item.', 'error');
    } finally {
      setMoving(false);
    }
  }

  function handleToggleOpen(checked: boolean) {
    setIsOpen(checked);
    setItemOpen(item.id, checked ? 1 : 0, locationId ? Number(locationId) : null).catch(() => setIsOpen(!checked));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val) || val < 0) return;
    await updateItemQuantity(item.id, val, 'set', multiLocation ? locationId || null : undefined);
    onClose();
  }

  return (
    <div data-testid="qty-modal" className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-xs p-6 text-center">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-rimmy-orange">Set Quantity</h3>
          <button type="button" data-testid="modal-close-button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>
        {/* noValidate: amount is pre-filled from a possibly-fractional legacy quantity, which would otherwise trip step="1"'s native stepMismatch and silently block Set — negative is floored in handleSubmit instead. */}
        <form onSubmit={handleSubmit} noValidate>
          {multiLocation && (
            <div className="mb-4 text-left">
              <label className="block text-sm font-bold mb-1 text-rimmy-text">Location</label>
              <select data-testid="qty-modal-location-select" value={locationId} onChange={(e) => handleLocationChange(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text">
                {item.locations.map((l) => (
                  <option key={l.location_id ?? 'unassigned'} value={l.location_id ?? ''}>
                    {l.location_name || 'Unassigned'} (qty {l.quantity})
                  </option>
                ))}
              </select>
              <label className="mt-2 flex items-center gap-2 text-sm text-rimmy-text">
                <input
                  type="checkbox"
                  data-testid="qty-modal-open-toggle"
                  checked={isOpen}
                  onChange={(e) => handleToggleOpen(e.target.checked)}
                />
                Mark this location's pack as open
              </label>
            </div>
          )}
          <input
            type="number"
            step="1"
            min="0"
            data-testid="qty-modal-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-center text-rimmy-text mb-4"
          />
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="touch-target flex-1 bg-gray-600 text-white rounded font-bold">
              Cancel
            </button>
            <button type="submit" data-testid="qty-modal-submit-button" className="touch-target flex-1 bg-rimmy-orange text-white rounded font-bold">
              Set
            </button>
          </div>
        </form>
        {moveDestinations.length > 0 && (
          <div className="mt-4 pt-4 border-t border-rimmy-border text-left">
            <label className="block text-sm font-bold mb-1 text-rimmy-text">Move stock to another location</label>
            <div className="flex gap-2">
              <select
                data-testid="qty-modal-move-location-select"
                value={moveToLocationId}
                onChange={(e) => setMoveToLocationId(e.target.value)}
                className="flex-1 bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text"
              >
                {moveDestinations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step="1"
                min="0"
                data-testid="qty-modal-move-amount-input"
                value={moveAmount}
                onChange={(e) => setMoveAmount(e.target.value)}
                className="w-20 bg-rimmy-black border border-rimmy-border rounded p-3 text-center text-rimmy-text"
              />
            </div>
            <button
              type="button"
              data-testid="qty-modal-move-button"
              onClick={handleMove}
              disabled={moving}
              className="touch-target w-full mt-2 bg-rimmy-purple hover:bg-rimmy-purpleHover text-white rounded font-bold disabled:opacity-50"
            >
              Move
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
