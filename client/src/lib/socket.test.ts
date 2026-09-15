import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function makeFakeSocket() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    auth: undefined as unknown,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(cb);
    }),
    off: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      (handlers[event] ?? []).forEach((cb) => cb(...args));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('socket.io-client');
});

describe('connectSocket connect_error handling', () => {
  it('ends the session when the handshake middleware rejects with Unauthorized', async () => {
    const fakeSocket = makeFakeSocket();
    vi.doMock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));
    const { connectSocket } = await import('./socket');
    const { onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'expired');
    const cb = vi.fn();
    onAuthExpired(cb);

    connectSocket();
    fakeSocket.emit('connect_error', new Error('Unauthorized'));

    expect(localStorage.getItem('tb_token')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not end the session for a non-auth connect_error (e.g. server restart or dropped wifi)', async () => {
    const fakeSocket = makeFakeSocket();
    vi.doMock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));
    const { connectSocket } = await import('./socket');
    const { onAuthExpired } = await import('./api');
    localStorage.setItem('tb_token', 'still-valid');
    const cb = vi.fn();
    onAuthExpired(cb);

    connectSocket();
    fakeSocket.emit('connect_error', new Error('xhr poll error'));

    expect(localStorage.getItem('tb_token')).toBe('still-valid');
    expect(cb).not.toHaveBeenCalled();
  });
});
