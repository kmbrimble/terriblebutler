import { useState } from 'react';
import { createItem, updateItem, updateItemQuantity, matchItem } from '../lib/api';
import type { Item, Location, Category, ItemPayload, MatchResult } from '../lib/api';

// Ports openEditModal()/buildItemPayload()/handleItemSubmit() from public/index.html.
// category_id can be genuinely NULL on live rows despite category_name being set (a category
// deleted after the item was tagged, or older data) — fall back to matching by name, then to
// the empty ("no category") option, exactly as legacy does.
export function matchCategoryId(item: Item, categories: Category[]): number | string {
  if (item.category_id) return item.category_id;
  if (item.category_name) {
    const found = categories.find((c) => c.name === item.category_name);
    if (found) return found.id;
  }
  return '';
}

export function ItemFormModal({
  mode,
  item,
  locations,
  categories,
  onClose,
}: {
  mode: 'add' | 'edit';
  item?: Item;
  locations: Location[];
  categories: Category[];
  onClose: () => void;
}) {
  const [barcode, setBarcode] = useState(() => item?.barcode ?? '');
  const [name, setName] = useState(() => item?.name ?? '');
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [categoryId, setCategoryId] = useState(() => (item ? matchCategoryId(item, categories) : ''));
  const [containerDetails, setContainerDetails] = useState(() => item?.container_details || '');
  const [threshold, setThreshold] = useState(() => String(item?.reorder_threshold || 0));
  const [price, setPrice] = useState('');
  const [vendor, setVendor] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [dupMatch, setDupMatch] = useState<MatchResult | null>(null);
  const [pendingPayload, setPendingPayload] = useState<ItemPayload | null>(null);

  function buildPayload(): ItemPayload {
    const payload: ItemPayload = {
      barcode,
      name,
      category_id: categoryId,
      container_details: containerDetails,
      reorder_threshold: parseFloat(threshold),
    };
    if (mode === 'add') {
      payload.location_id = locationId;
      payload.quantity = parseFloat(quantity);
    }
    const parsedPrice = parseFloat(price);
    if (!isNaN(parsedPrice) && parsedPrice > 0) {
      payload.price = parsedPrice;
      payload.vendor = vendor || '';
      if (purchaseDate) payload.purchase_date = purchaseDate;
    }
    return payload;
  }

  async function submitPayload(payload: ItemPayload) {
    if (item) {
      await updateItem(item.id, payload);
    } else {
      await createItem(payload);
    }
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = buildPayload();

    if (mode === 'add') {
      const match = await matchItem(payload.name, payload.barcode || undefined);
      if (match && match.type) {
        setPendingPayload(payload);
        setDupMatch(match);
        return;
      }
    }
    await submitPayload(payload);
  }

  async function useExisting(existingId: number) {
    if (!pendingPayload) return;
    await updateItemQuantity(existingId, pendingPayload.quantity || 0, 'add', pendingPayload.location_id || null);
    onClose();
  }

  async function proceedAsNew() {
    if (!pendingPayload) return;
    const payload = pendingPayload;
    setDupMatch(null);
    setPendingPayload(null);
    await submitPayload(payload);
  }

  const typeLabel = (type: MatchResult['type']) =>
    type === 'barcode' ? 'barcode match' : type === 'exact_name' ? 'exact name match' : 'fuzzy match';

  return (
    <div data-testid="add-modal" className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <h2 className="text-xl font-bold mb-4 text-rimmy-orange">{mode === 'add' ? 'Add Item' : 'Edit Item'}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-bold mb-1 text-rimmy-text">Barcode</label>
            <input data-testid="item-barcode-input" value={barcode} onChange={(e) => setBarcode(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
          </div>
          <div>
            <label className="block text-sm font-bold mb-1 text-rimmy-text">Name *</label>
            <input data-testid="item-name-input" required value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {mode === 'add' && (
              <div className="flex-1">
                <label className="block text-sm font-bold mb-1 text-rimmy-text">Location</label>
                <select data-testid="item-location-select" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text">
                  <option value="">Select...</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex-1">
              <label className="block text-sm font-bold mb-1 text-rimmy-text">Category</label>
              <select data-testid="item-category-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text">
                <option value="">Select...</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-bold mb-1 text-rimmy-text">Container Details</label>
            <input value={containerDetails} onChange={(e) => setContainerDetails(e.target.value)} placeholder="Size, weight, type" className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {mode === 'add' && (
              <div className="flex-1">
                <label className="block text-sm font-bold mb-1 text-rimmy-text">Quantity</label>
                <input type="number" step="0.1" data-testid="item-quantity-input" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
              </div>
            )}
            <div className="flex-1">
              <label className="block text-sm font-bold mb-1 text-rimmy-text">Reorder Threshold</label>
              <input type="number" step="1" data-testid="item-threshold-input" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
            </div>
          </div>
          {mode === 'edit' && <p className="text-xs text-rimmy-textMuted -mt-2">Use the qty +/- controls or item details to adjust stock per location.</p>}

          <div className="border-t border-rimmy-border pt-4 mt-2">
            <h3 className="text-sm font-bold text-rimmy-orange mb-2">Optional Purchase Record</h3>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1">
                <label className="block text-xs font-bold mb-1 text-rimmy-textMuted">Price ($)</label>
                <input type="number" step="0.01" data-testid="item-price-input" value={price} onChange={(e) => setPrice(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-2 text-rimmy-text" />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-bold mb-1 text-rimmy-textMuted">Vendor</label>
                <input data-testid="item-vendor-input" value={vendor} onChange={(e) => setVendor(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-2 text-rimmy-text" />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-bold mb-1 text-rimmy-textMuted">Date</label>
                <input type="date" data-testid="item-date-input" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className="w-full bg-rimmy-black border border-rimmy-border rounded p-2 text-rimmy-text" />
              </div>
            </div>
          </div>

          {dupMatch && (
            <div data-testid="dup-check-panel" className="border border-amber-500 rounded p-3 bg-rimmy-black space-y-2">
              <p className="text-sm font-bold text-amber-400">Possible existing item(s) found:</p>
              <div className="space-y-2">
                {dupMatch.candidates.map((c) => (
                  <div key={c.id} className="flex justify-between items-center gap-2 bg-rimmy-charcoal p-2 rounded border border-rimmy-border">
                    <span className="text-sm text-rimmy-text">
                      {c.name} <span className="text-xs text-rimmy-textMuted">(qty {c.quantity}, {typeLabel(dupMatch.type)})</span>
                    </span>
                    <button type="button" onClick={() => useExisting(c.id)} className="touch-target px-3 py-1 bg-rimmy-purple text-white text-xs font-bold rounded">
                      Use this
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={proceedAsNew} className="text-xs underline text-rimmy-textMuted hover:text-rimmy-orange">
                Add as new item anyway
              </button>
            </div>
          )}

          <div className="flex gap-4 pt-4">
            <button type="button" onClick={onClose} className="touch-target flex-1 bg-gray-600 text-white rounded font-bold">
              Cancel
            </button>
            <button type="submit" data-testid="item-form-submit-button" className="touch-target flex-1 bg-rimmy-orange text-white rounded font-bold">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
