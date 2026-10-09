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
  const ok = { ok: true, status: 200, json: async () => ({ success: true }) };

  it('sends the re-entered password and ends the local session once the server has revoked everything', async () => {
    const { revokeAllSessions, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'live-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok);
    const cb = vi.fn();
    onAuthExpired(cb);

    await revokeAllSessions('hunter2');

    expect(fetch).toHaveBeenCalledWith('/api/auth/revoke-all', expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'hunter2' }) }));
    expect(localStorage.getItem('tb_token')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('keeps the session and surfaces the server message on a wrong password (403 is not an expired session)', async () => {
    const { revokeAllSessions, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'live-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Incorrect password.' }) });
    const cb = vi.fn();
    onAuthExpired(cb);

    await expect(revokeAllSessions('nope')).rejects.toThrow('Incorrect password.');
    expect(localStorage.getItem('tb_token')).toBe('live-token');
    expect(cb).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the server gives none', async () => {
    const { revokeAllSessions } = await import('./api');
    localStorage.setItem('tb_token', 'live-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('no body'); } });

    await expect(revokeAllSessions('pw')).rejects.toThrow('Failed to sign out everywhere.');
    expect(localStorage.getItem('tb_token')).toBe('live-token');
  });
});

describe('revokeDevice', () => {
  it('posts the password to the device revoke endpoint and keeps the session', async () => {
    const { revokeDevice, onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'live-token');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    const cb = vi.fn();
    onAuthExpired(cb);

    await revokeDevice(7, 'hunter2');

    expect(fetch).toHaveBeenCalledWith('/api/auth/devices/7/revoke', expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'hunter2' }) }));
    expect(localStorage.getItem('tb_token')).toBe('live-token');
    expect(cb).not.toHaveBeenCalled();
  });

  it('rejects with the server message on a wrong password', async () => {
    const { revokeDevice } = await import('./api');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Incorrect password.' }) });
    await expect(revokeDevice(7, 'nope')).rejects.toThrow('Incorrect password.');
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

describe('matchItem', () => {
  it('rejects when the duplicate check fails instead of quietly reporting "no match"', async () => {
    const { matchItem } = await import('./api');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Simulated failure' }) });
    await expect(matchItem('Milk')).rejects.toThrow('Simulated failure');
  });
});

describe('password confirmation rate limit (429)', () => {
  const respond = (headers: Record<string, string>, body: unknown) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 429, headers: new Headers(headers), json: async () => body });
  const message = async () => {
    const { revokeDevice } = await import('./api');
    localStorage.setItem('tb_token', 't');
    return ((await revokeDevice(1, 'pw').catch((e: Error) => e)) as Error).message;
  };

  it('the sign-in limiter: explains the shared attempt limit, its window and how long to wait, all from the server', async () => {
    respond({ 'Retry-After': '600', 'RateLimit-Limit': '5', 'RateLimit-Policy': '5;w=900;name="login"' }, { limiter: 'login' });
    expect(await message()).toMatch(/signing in, which allows 5 attempts every 15 minutes.*10 minutes/);
  });

  it('takes the limit and window from the server, not a constant', async () => {
    respond({ 'Retry-After': '30', 'RateLimit-Limit': '12', 'RateLimit-Policy': '12;w=300;name="login"' }, { limiter: 'login' });
    const text = await message();
    expect(text).toMatch(/allows 12 attempts every 5 minutes.*30 seconds/);
    expect(text).not.toMatch(/\b5 attempts|15 minutes/);
  });

  it.each(['api', 'mutation', 'llm'])('the %s limiter is not blamed on password attempts', async (limiter) => {
    respond({ 'Retry-After': '20', 'RateLimit-Limit': '240', 'RateLimit-Policy': `240;w=60;name="${limiter}"` }, { limiter });
    const text = await message();
    expect(text).toMatch(/Too many requests right now.*20 seconds/);
    expect(text).not.toMatch(/password|signing in|attempt/i);
  });

  it('a 429 that does not say which limiter fired (or has no JSON body) is not attributed to sign-in either', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '45' }), json: async () => { throw new Error('not json'); } });
    expect(await message()).toMatch(/Too many requests right now.*45 seconds/);
  });

  it('falls back to a generic wait when Retry-After is absent', async () => {
    const { passwordAttemptsMessage } = await import('./api');
    expect(passwordAttemptsMessage(null)).toMatch(/a few minutes/);
    expect(passwordAttemptsMessage('45', null, 'login')).toMatch(/45 seconds/);
    // no limit header: nothing is claimed about the number
    expect(passwordAttemptsMessage('45', null, 'login')).not.toMatch(/\d+ attempts?/);
    expect(passwordAttemptsMessage(null, 'abc', 'login')).toMatch(/rate limited/);
    expect(passwordAttemptsMessage(null, '1', 'login', 60)).toMatch(/1 attempt every 60 seconds/);
  });
});

describe('getDevices', () => {
  it('passes the abort signal to fetch', async () => {
    const { getDevices } = await import('./api');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const controller = new AbortController();
    await getDevices(controller.signal);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].signal).toBe(controller.signal);
  });
});
