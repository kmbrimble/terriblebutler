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

// Shapes below are read directly from server.js: GET /api/items' SQL (items.* plus
// location_name/category_name/quantity) and parseItemLocations() for the `locations` array.

export interface ItemLocation {
  location_id: number | null;
  location_name: string | null;
  quantity: number;
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

export interface MatchCandidate {
  id: number;
  name: string;
  quantity: number;
}

export interface MatchResult {
  type: 'barcode' | 'exact_name' | 'fuzzy' | null;
  candidates: MatchCandidate[];
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
