import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchExpiry } from '../lib/realtime.js';

// Minimal stand-in for a socket.io Socket: just what watchExpiry touches.
function fakeSocket(credential) {
  const handlers = {};
  const socket = {
    data: { credential },
    emit: vi.fn(),
    once: (event, cb) => { handlers[event] = cb; },
    disconnect: vi.fn(() => handlers.disconnect?.()),
  };
  return socket;
}

afterEach(() => vi.useRealTimers());

describe('watchExpiry', () => {
  it('disconnects the socket when its credential expires, telling the client why', () => {
    vi.useFakeTimers();
    const socket = fakeSocket({ type: 'jwt', jti: 'a', expiresAt: Date.now() + 5000 });
    watchExpiry(socket, (c) => c.expiresAt);

    vi.advanceTimersByTime(4999);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(socket.emit).toHaveBeenCalledWith('session_revoked');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('survives expiry dates beyond the setTimeout limit (a 30-day JWT)', () => {
    vi.useFakeTimers();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const socket = fakeSocket({ type: 'jwt', jti: 'a', expiresAt: Date.now() + thirtyDays });
    watchExpiry(socket, (c) => c.expiresAt);

    vi.advanceTimersByTime(thirtyDays - 1000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('re-reads the expiry when the timer fires, so a slid device-token expiry keeps the socket', () => {
    vi.useFakeTimers();
    let expiresAt = Date.now() + 1000;
    const socket = fakeSocket({ type: 'device', id: 1, expiresAt });
    watchExpiry(socket, () => expiresAt);

    expiresAt = Date.now() + 10_000; // the device made API calls meanwhile
    vi.advanceTimersByTime(1500);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9000);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects when the credential has been revoked in the meantime (expiry null)', () => {
    vi.useFakeTimers();
    let revoked = false;
    const socket = fakeSocket({ type: 'device', id: 1, expiresAt: Date.now() + 1000 });
    watchExpiry(socket, (c) => (revoked ? null : c.expiresAt + 5000));
    revoked = true;
    vi.advanceTimersByTime(1001);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('clears its timer when the socket disconnects first, leaving nothing pending', () => {
    vi.useFakeTimers();
    const socket = fakeSocket({ type: 'jwt', jti: 'a', expiresAt: Date.now() + 60_000 });
    watchExpiry(socket, (c) => c.expiresAt);
    expect(vi.getTimerCount()).toBe(1);

    socket.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnects rather than throwing if the expiry lookup fails', () => {
    vi.useFakeTimers();
    const socket = fakeSocket({ type: 'device', id: 1, expiresAt: Date.now() + 1000 });
    watchExpiry(socket, () => { throw new Error('db closed'); });
    expect(() => vi.advanceTimersByTime(1001)).not.toThrow();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
