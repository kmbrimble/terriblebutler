import { useState } from 'react';
import { updateItemQuantity } from '../lib/api';
import type { Item } from '../lib/api';

// Ports openQtyModal()/submitManualQty() from public/index.html: always sets an absolute
// quantity (never a delta), with a location picker only when the item has stock in more than
// one location.
export function QtyModal({ item, onClose }: { item: Item; onClose: () => void }) {
  const multiLocation = item.locations.length > 1;
  const [locationId, setLocationId] = useState(() => String(item.locations[0]?.location_id ?? ''));
  const [amount, setAmount] = useState(() => {
    if (multiLocation) return String(item.locations[0]?.quantity ?? 0);
    return String(item.quantity);
  });

  function handleLocationChange(value: string) {
    setLocationId(value);
    const loc = item.locations.find((l) => String(l.location_id ?? '') === value);
    setAmount(String(loc ? loc.quantity : 0));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val)) return;
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
        <form onSubmit={handleSubmit}>
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
            </div>
          )}
          <input
            type="number"
            step="0.1"
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
      </div>
    </div>
  );
}
