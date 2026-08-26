// Plain TypeScript, no React or DOM-library imports — this is the layer the eventual React
// Native app reuses. Only ambient Web-standard globals (fetch, localStorage) are used, which
// have React Native equivalents/polyfills.

const TOKEN_KEY = 'tb_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Login failed.');
  }
  localStorage.setItem(TOKEN_KEY, data.token);
}

// Enrols the current device as a trusted device: exchanges the just-issued JWT for a
// long-lived, individually-revocable device token, and overwrites tb_token with it — the
// server accepts both token shapes under the same Authorization header, so no other client
// code needs to know which kind is stored.
export async function rememberDevice(deviceLabel: string): Promise<void> {
  const res = await fetch('/api/auth/device-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}`,
    },
    body: JSON.stringify({ device_label: deviceLabel }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to remember this device.');
  }
  localStorage.setItem(TOKEN_KEY, data.token);
}

// Shapes below are read directly from server.js: GET /api/items' SQL (items.* plus
// location_name/category_name/quantity) and parseItemLocations() for the `locations` array.

export interface ItemLocation {
  location_id: number | null;
  location_name: string | null;
  quantity: number;
  // Optional: the API always sends it, but this keeps every pre-existing fixture literal
  // across the test suite (built before this field existed) source-compatible.
  is_open?: number;
}

export interface Item {
  id: number;
  barcode: string | null;
  name: string;
  location_id: number | null;
  category_id: number | null;
  container_details: string;
  quantity: number;
  reorder_threshold: number;
  is_ignored_grocery: number | null;
  image_path: string | null;
  last_price: number | null;
  lowest_price: number | null;
  created_at: string;
  updated_at: string;
  location_name: string | null;
  category_name: string | null;
  locations: ItemLocation[];
}

export interface Location {
  id: number;
  name: string;
}

export interface Category {
  id: number;
  name: string;
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token ?? ''}`,
    },
  });
}

export async function getItems(): Promise<Item[]> {
  const res = await authorizedFetch('/api/items');
  if (!res.ok) throw new Error('Failed to fetch items.');
  return res.json();
}

export async function getLocations(): Promise<Location[]> {
  const res = await authorizedFetch('/api/locations');
  if (!res.ok) throw new Error('Failed to fetch locations.');
  return res.json();
}

export async function getCategories(): Promise<Category[]> {
  const res = await authorizedFetch('/api/categories');
  if (!res.ok) throw new Error('Failed to fetch categories.');
  return res.json();
}

// Shapes mirror server.js's GET /api/items/:id/details and GET /api/items/:id/price-history —
// price/vendor are genuinely nullable on price_history rows despite `price` being a REAL
// column (confirmed against live data during the stage-4 audit); recorded_at always has a
// value (DEFAULT CURRENT_TIMESTAMP, no insert path omits it).
export interface PriceHistoryEntry {
  id: number;
  item_id: number;
  price: number | null;
  vendor: string | null;
  recorded_at: string;
}

export interface PurchaseSummary {
  price: number;
  vendor: string;
  recorded_at: string;
}

export interface ItemDetails extends Item {
  last_purchase: PurchaseSummary | null;
  lowest_purchase: PurchaseSummary | null;
}

export async function getItemDetails(id: number): Promise<ItemDetails> {
  const res = await authorizedFetch(`/api/items/${id}/details`);
  if (!res.ok) throw new Error('Failed to fetch item details.');
  return res.json();
}

export async function getPriceHistory(id: number): Promise<PriceHistoryEntry[]> {
  const res = await authorizedFetch(`/api/items/${id}/price-history`);
  if (!res.ok) throw new Error('Failed to fetch price history.');
  return res.json();
}

export async function deletePriceHistoryEntry(id: number): Promise<void> {
  const res = await authorizedFetch(`/api/price-history/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete the price history entry.');
}

export async function getGroceryList(): Promise<Item[]> {
  const res = await authorizedFetch('/api/grocery-list');
  if (!res.ok) throw new Error('Failed to fetch the grocery list.');
  return res.json();
}

export async function getOutOfStockIgnored(): Promise<Item[]> {
  const res = await authorizedFetch('/api/out-of-stock-ignored');
  if (!res.ok) throw new Error('Failed to fetch ignored out-of-stock items.');
  return res.json();
}

export async function createLocation(name: string): Promise<Location> {
  const res = await authorizedFetch('/api/locations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create location.');
  return data;
}

export async function createCategory(name: string): Promise<Category> {
  const res = await authorizedFetch('/api/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create category.');
  return data;
}

export async function updateLocation(id: number, name: string): Promise<Location> {
  const res = await authorizedFetch(`/api/locations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update location.');
  return data;
}

export async function deleteLocation(id: number): Promise<void> {
  const res = await authorizedFetch(`/api/locations/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete location.');
}

export async function updateCategory(id: number, name: string): Promise<Category> {
  const res = await authorizedFetch(`/api/categories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update category.');
  return data;
}

export async function deleteCategory(id: number): Promise<void> {
  const res = await authorizedFetch(`/api/categories/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete category.');
}

export async function getItemByBarcode(barcode: string): Promise<Item | null> {
  const res = await authorizedFetch(`/api/items/barcode/${encodeURIComponent(barcode)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to look up barcode.');
  return res.json();
}

// Mirrors applyLabelScanResult()'s server contract exactly — category_id/location_id are
// direct matches (or null), suggested_*_name/similar_* drive the fuzzy-match suggestion picker.
export interface LabelScanResult {
  name: string;
  container_details: string;
  category_id: number | null;
  location_id: number | null;
  suggested_category_name: string | null;
  similar_category: { id: number; name: string } | null;
  suggested_location_name: string | null;
  similar_location: { id: number; name: string } | null;
}

export async function parseLabelImage(blob: Blob): Promise<LabelScanResult> {
  const formData = new FormData();
  formData.append('image', blob, 'cropped_label.jpg');
  const res = await authorizedFetch('/api/parse-label-llm', { method: 'POST', body: formData });
  if (!res.ok) throw new Error('Failed to parse label image.');
  return res.json();
}

// Shapes mirror server.js's getImportWithLines() and the invoice_import_lines schema exactly —
// all suggestion/final/scan fields are genuinely nullable, no live rows exist yet to sample.
export interface InvoiceImport {
  id: number;
  retailer: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  status: string;
}

export interface InvoiceImportLine {
  id: number;
  import_id: number;
  raw_name: string;
  qty_ordered: number | null;
  qty_supplied: number | null;
  unit_price: number | null;
  line_total: number | null;
  gst_applicable: number;
  matched_item_id: number | null;
  suggested_category_id: number | null;
  suggested_location_id: number | null;
  final_category_id: number | null;
  final_location_id: number | null;
  barcode_scanned: string | null;
  qty_confirmed: number | null;
  line_status: 'pending' | 'reviewed' | 'skipped';
}

export interface InvoiceImportState {
  import: InvoiceImport;
  lines: InvoiceImportLine[];
}

export async function startInvoiceImport(file: File): Promise<InvoiceImportState> {
  const formData = new FormData();
  formData.append('invoice', file);
  const res = await authorizedFetch('/api/invoices/import', { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to import invoice.');
  return data;
}

export async function getInvoiceImport(id: number): Promise<InvoiceImportState | null> {
  const res = await authorizedFetch(`/api/invoices/import/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch invoice import.');
  return res.json();
}

export async function patchInvoiceImportLine(
  importId: number,
  lineId: number,
  fields: Partial<Pick<InvoiceImportLine, 'final_category_id' | 'final_location_id' | 'qty_confirmed' | 'barcode_scanned' | 'line_status'>>
): Promise<InvoiceImportLine> {
  const res = await authorizedFetch(`/api/invoices/import/${importId}/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update the invoice line.');
  return data;
}

export interface InvoiceCommitSummary {
  items_added: number;
  items_matched: number;
  total_value: number;
}

export async function commitInvoiceImport(importId: number): Promise<InvoiceCommitSummary> {
  const res = await authorizedFetch(`/api/invoices/import/${importId}/commit`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to commit the invoice import.');
  return data;
}

// Shared add/edit payload shape — mirrors buildItemPayload() in public/index.html exactly.
// location_id/quantity are add-only (stock is per-location; editing them here would be
// ambiguous for a multi-location item). price/vendor/date represent a NEW purchase record,
// never a pre-fill of the item's existing last_price/lowest_price.
export interface ItemPayload {
  barcode: string;
  name: string;
  category_id: number | string;
  container_details: string;
  reorder_threshold: number;
  location_id?: number | string;
  quantity?: number;
  price?: number;
  vendor?: string;
  purchase_date?: string;
}

export async function createItem(payload: ItemPayload): Promise<Item> {
  const res = await authorizedFetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to add item.');
  return data;
}

export async function updateItem(id: number, payload: ItemPayload): Promise<Item> {
  const res = await authorizedFetch(`/api/items/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update item.');
  return data;
}

export type QuantityAction = 'add' | 'subtract' | 'set';

export async function updateItemQuantity(
  id: number,
  amount: number,
  action: QuantityAction,
  locationId?: number | string | null
): Promise<Item> {
  const body: Record<string, unknown> = { amount, action };
  if (locationId !== undefined) body.location_id = locationId;
  const res = await authorizedFetch(`/api/items/${id}/quantity`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update quantity.');
  return data;
}

export async function deductItem(id: number, amount: number, locationId?: number | string | null): Promise<Item> {
  const body: Record<string, unknown> = { amount };
  if (locationId !== undefined) body.location_id = locationId;
  const res = await authorizedFetch(`/api/items/${id}/deduct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to deduct item.');
  return data;
}

export async function setIgnoreGrocery(id: number, isIgnored: 0 | 1): Promise<Item> {
  const res = await authorizedFetch(`/api/items/${id}/ignore-grocery`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_ignored_grocery: isIgnored }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update the grocery list flag.');
  return data;
}

export async function moveItemLocation(
  id: number,
  amount: number,
  fromLocationId: number | string | null | undefined,
  toLocationId: number | string | null
): Promise<Item> {
  const body: Record<string, unknown> = { amount, to_location_id: toLocationId };
  if (fromLocationId !== undefined) body.from_location_id = fromLocationId;
  const res = await authorizedFetch(`/api/items/${id}/move-location`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to move item.');
  return data;
}

export async function setItemOpen(id: number, isOpen: 0 | 1, locationId: number | null): Promise<Item> {
  const res = await authorizedFetch(`/api/items/${id}/open`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_open: isOpen, location_id: locationId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update the open flag.');
  return data;
}

export interface MatchCandidate {
  id: number;
  name: string;
  quantity: number;
}

export interface MatchResult {
  type: 'barcode' | 'exact_name' | 'fuzzy' | null;
  candidates: MatchCandidate[];
}

export interface DeviceToken {
  id: number;
  device_label: string;
  created_at: string;
  last_used_at: string;
  revoked: number;
}

export async function getDevices(): Promise<DeviceToken[]> {
  const res = await authorizedFetch('/api/auth/devices');
  if (!res.ok) throw new Error('Failed to fetch devices.');
  return res.json();
}

export async function revokeDevice(id: number): Promise<void> {
  const res = await authorizedFetch(`/api/auth/devices/${id}/revoke`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to revoke device.');
}

export async function matchItem(name: string, barcode?: string): Promise<MatchResult | null> {
  const params = new URLSearchParams({ name });
  if (barcode) params.set('barcode', barcode);
  try {
    const res = await authorizedFetch(`/api/items/match?${params.toString()}`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}
