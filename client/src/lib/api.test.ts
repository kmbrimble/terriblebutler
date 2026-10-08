import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No jsdom in this project's vitest config (environment: 'node') — localStorage and fetch are
// stubbed directly rather than reaching for a DOM environment, matching the rest of the suite.
function makeLocalStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
  vi.stubGlobal('fetch', vi.fn());
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authorizedFetch 401 handling', () => {
  it('clears the token and notifies onAuthExpired subscribers on a 401', async () => {
    const { getItems, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'expired-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    });
    const cb = vi.fn();
    onAuthExpired(cb);

    await expect(getItems()).rejects.toThrow();

    expect(localStorage.getItem('tb_token')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('leaves the token and subscribers untouched on a non-401 failure', async () => {
    const { getItems, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'still-valid');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const cb = vi.fn();
    onAuthExpired(cb);

    await expect(getItems()).rejects.toThrow();

    expect(localStorage.getItem('tb_token')).toBe('still-valid');
    expect(cb).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    const { getItems, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'expired-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const cb = vi.fn();
    const unsubscribe = onAuthExpired(cb);
    unsubscribe();

    await expect(getItems()).rejects.toThrow();

    expect(cb).not.toHaveBeenCalled();
  });
});

describe('revokeAllSessions', () => {
  it('ends the local session once the server has revoked everything', async () => {
    const { revokeAllSessions, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'live-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const cb = vi.fn();
    onAuthExpired(cb);

    await revokeAllSessions();

    expect(fetch).toHaveBeenCalledWith('/api/auth/revoke-all', expect.objectContaining({ method: 'POST' }));
    expect(localStorage.getItem('tb_token')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('keeps the session and throws when the server refuses', async () => {
    const { revokeAllSessions } = await import('./api');
    localStorage.setItem('tb_token', 'live-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(revokeAllSessions()).rejects.toThrow();
    expect(localStorage.getItem('tb_token')).toBe('live-token');
  });
});

describe('mergeIntoItem', () => {
  it('posts the whole pending payload (quantity, location and purchase record) to the merge endpoint', async () => {
    const { mergeIntoItem } = await import('./api');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 5 }) });
    await mergeIntoItem(5, {
      barcode: '', name: 'Milk', category_id: '', container_details: '', reorder_threshold: 0,
      location_id: '', quantity: 2, price: 3.2, vendor: 'Shop', purchase_date: '2026-01-02',
    });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/items/5/merge');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).not.toHaveProperty('location_id');
    expect(JSON.parse(init.body)).toEqual({ quantity: 2, price: 3.2, vendor: 'Shop', purchase_date: '2026-01-02' });
  });
});
