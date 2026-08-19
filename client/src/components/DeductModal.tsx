import { useState } from 'react';
import { deductItem } from '../lib/api';
import type { Item } from '../lib/api';

// Ports openDeductModal()/filterDeductItems()/submitDeduct() from public/index.html: search
// the already-loaded item list client-side (no extra API call), then deduct from a single
// location directly or via a picker when the item has stock in more than one.
export function DeductModal({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [locationId, setLocationId] = useState('');
  const [amount, setAmount] = useState('1');

  const query = search.toLowerCase();
  const results = query
    ? items.filter((i) => (i.name && i.name.toLowerCase().includes(query)) || (i.barcode && i.barcode.toLowerCase().includes(query))).slice(0, 10)
    : [];

  function selectItem(item: Item) {
    setSelected(item);
    setLocationId('');
    setAmount('1');
  }

  function reset() {
    setSelected(null);
    setSearch('');
    setAmount('1');
    setLocationId('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    const multiLocation = selected.locations.length > 1;
    await deductItem(selected.id, val, multiLocation ? locationId || null : undefined);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <h2 className="text-xl font-bold mb-4 text-rimmy-orange">Deduct Stock</h2>

        {!selected ? (
          <div>
            <input
              type="text"
              data-testid="deduct-search-input"
              placeholder="Search items..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text mb-2"
            />
            <div className="space-y-2">
              {results.map((i) => (
                <div key={i.id} data-testid="deduct-list-item" onClick={() => selectItem(i)} className="bg-rimmy-black p-2 rounded border border-rimmy-border cursor-pointer">
                  <p className="font-bold text-rimmy-orange truncate">{i.name}</p>
                  <p className="text-xs text-rimmy-textMuted">
                    {i.locations.length > 1 ? `${i.locations.length} locations` : i.locations[0]?.location_name || 'No Loc'} | Qty: {i.quantity}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <form data-testid="deduct-action-container" onSubmit={handleSubmit} className="space-y-4">
            <p className="font-bold text-rimmy-text">{selected.name}</p>
            <div>
              <label className="block text-sm font-bold mb-1 text-rimmy-text">Quantity</label>
              <input type="number" step="0.1" data-testid="deduct-quantity-input" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
            </div>
            {selected.locations.length > 1 && (
              <div>
                <label className="block text-sm font-bold mb-1 text-rimmy-text">Location</label>
                <select data-testid="deduct-location-select" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text">
                  <option value="">Select...</option>
                  {selected.locations.map((l) => (
                    <option key={l.location_id ?? 'unassigned'} value={l.location_id ?? ''}>
                      {l.location_name || 'Unassigned'} (qty {l.quantity})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" data-testid="deduct-reset-button" onClick={reset} className="touch-target flex-1 bg-gray-600 text-white rounded font-bold">
                Back
              </button>
              <button type="submit" data-testid="deduct-submit-button" className="touch-target flex-1 bg-rimmy-purple text-white rounded font-bold">
                Deduct
              </button>
            </div>
          </form>
        )}

        <div className="flex gap-4 pt-4">
          <button type="button" onClick={onClose} className="touch-target flex-1 bg-gray-600 text-white rounded font-bold">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
