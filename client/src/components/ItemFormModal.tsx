import { useRef, useState } from 'react';
import { createItem, updateItem, updateItemQuantity, matchItem, parseLabelImage, createCategory, createLocation } from '../lib/api';
import type { Item, Location, Category, ItemPayload, MatchResult } from '../lib/api';
import { deriveLabelScanUpdate } from '../lib/labelScan';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import { CropModal } from './CropModal';
import { SuggestBlock } from './SuggestBlock';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';

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
  useLockBodyScroll();
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
  const [pendingKeepOpen, setPendingKeepOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [categorySuggestion, setCategorySuggestion] = useState<ReturnType<typeof deriveLabelScanUpdate>['categorySuggestion']>(null);
  const [locationSuggestion, setLocationSuggestion] = useState<ReturnType<typeof deriveLabelScanUpdate>['locationSuggestion']>(null);
  const [parsingLabel, setParsingLabel] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Resets add-mode fields back to blank/default for "Save and Add Another" — mirrors this
  // component's own initial useState defaults exactly.
  function resetForm() {
    setBarcode('');
    setName('');
    setLocationId('');
    setQuantity('1');
    setCategoryId('');
    setContainerDetails('');
    setThreshold('0');
    setPrice('');
    setVendor('');
    setPurchaseDate('');
    setDupMatch(null);
    setPendingPayload(null);
    setPendingKeepOpen(false);
    setCategorySuggestion(null);
    setLocationSuggestion(null);
  }

  async function submitPayload(payload: ItemPayload, keepOpen: boolean) {
    if (item) {
      await updateItem(item.id, payload);
    } else {
      await createItem(payload);
    }
    if (keepOpen) resetForm();
    else onClose();
  }

  async function mergeQuantityInto(existingId: number, payload: ItemPayload, keepOpen: boolean) {
    await updateItemQuantity(existingId, payload.quantity || 0, 'add', payload.location_id || null);
    if (keepOpen) resetForm();
    else onClose();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Both Save and Save-and-Add-Another are type="submit" (so the Name field's native
    // `required` validation applies to either) — SubmitEvent.submitter tells them apart.
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const addAnother = submitter?.value === 'addAnother';
    const payload = buildPayload();

    if (mode === 'add') {
      const match = await matchItem(payload.name, payload.barcode || undefined);
      // An exact case-insensitive name match is unambiguous, so it auto-merges without asking
      // — unlike barcode/fuzzy matches, which can't be that certain and still show the panel.
      if (match && match.type === 'exact_name' && match.candidates.length === 1) {
        await mergeQuantityInto(match.candidates[0].id, payload, addAnother);
        return;
      }
      if (match && match.type) {
        setPendingPayload(payload);
        setPendingKeepOpen(addAnother);
        setDupMatch(match);
        return;
      }
    }
    await submitPayload(payload, addAnother);
  }

  async function useExisting(existingId: number) {
    if (!pendingPayload) return;
    await mergeQuantityInto(existingId, pendingPayload, pendingKeepOpen);
  }

  async function proceedAsNew() {
    if (!pendingPayload) return;
    const payload = pendingPayload;
    const keepOpen = pendingKeepOpen;
    setDupMatch(null);
    setPendingPayload(null);
    await submitPayload(payload, keepOpen);
  }

  const typeLabel = (type: MatchResult['type']) =>
    type === 'barcode' ? 'barcode match' : type === 'exact_name' ? 'exact name match' : 'fuzzy match';

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropImageSrc(reader.result as string);
    reader.readAsDataURL(file);
  }

  function cancelCrop() {
    setCropImageSrc(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function confirmCrop(blob: Blob) {
    setCropImageSrc(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setParsingLabel(true);
    const data = await parseLabelImage(blob).catch(() => null);
    setParsingLabel(false);
    if (!data) return;
    const update = deriveLabelScanUpdate(data);
    if (update.name !== undefined) setName(update.name);
    if (update.container_details !== undefined) setContainerDetails(update.container_details);
    if (update.category_id !== undefined) setCategoryId(String(update.category_id));
    if (update.location_id !== undefined) setLocationId(String(update.location_id));
    setCategorySuggestion(update.categorySuggestion);
    setLocationSuggestion(update.locationSuggestion);
  }

  return (
    <div data-testid="add-modal" className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-rimmy-orange">{mode === 'add' ? 'Add Item' : 'Edit Item'}</h2>
          <button type="button" data-testid="modal-close-button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        <div className="mb-4">
          <button
            type="button"
            data-testid="snap-label-button"
            onClick={() => fileInputRef.current?.click()}
            className="touch-target w-full bg-rimmy-purple hover:bg-rimmy-purpleHover text-white rounded font-bold"
          >
            Snap Label with LLM
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-testid="snap-label-file-input"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileSelected}
          />
          {parsingLabel && <p data-testid="label-parsing-indicator" className="text-xs text-rimmy-textMuted mt-1">Reading label…</p>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-bold mb-1 text-rimmy-text">Barcode</label>
            <div className="flex gap-2">
              <input data-testid="item-barcode-input" value={barcode} onChange={(e) => setBarcode(e.target.value)} className="flex-1 bg-rimmy-black border border-rimmy-border rounded p-3 text-rimmy-text" />
              <button
                type="button"
                data-testid="barcode-scan-button"
                onClick={() => setScannerOpen(true)}
                className="touch-target w-12 flex items-center justify-center bg-rimmy-charcoal border border-rimmy-border hover:border-rimmy-orange text-rimmy-text rounded"
              >
                #
              </button>
            </div>
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
                {locationSuggestion && (
                  <div className="mt-2">
                    <SuggestBlock
                      kind="location"
                      suggestion={locationSuggestion}
                      items={locations}
                      onCreate={createLocation}
                      onApply={(id) => {
                        setLocationId(String(id));
                        setLocationSuggestion(null);
                      }}
                    />
                  </div>
                )}
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
              {categorySuggestion && (
                <div className="mt-2">
                  <SuggestBlock
                    kind="category"
                    suggestion={categorySuggestion}
                    items={categories}
                    onCreate={createCategory}
                    onApply={(id) => {
                      setCategoryId(String(id));
                      setCategorySuggestion(null);
                    }}
                  />
                </div>
              )}
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
            {mode === 'add' && (
              <button
                type="submit"
                name="intent"
                value="addAnother"
                data-testid="item-form-save-add-another-button"
                className="touch-target flex-1 bg-rimmy-purple hover:bg-rimmy-purpleHover text-white rounded font-bold text-sm"
              >
                Save + Add Another
              </button>
            )}
            <button type="submit" name="intent" value="save" data-testid="item-form-submit-button" className="touch-target flex-1 bg-rimmy-orange text-white rounded font-bold">
              Save
            </button>
          </div>
        </form>
      </div>
      {scannerOpen && (
        <BarcodeScannerModal
          onScan={(text) => {
            setBarcode(text);
            setScannerOpen(false);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
      {cropImageSrc && <CropModal imageSrc={cropImageSrc} onConfirm={confirmCrop} onCancel={cancelCrop} />}
    </div>
  );
}
