import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const { isOriginAllowed } = createRequire(import.meta.url)('../lib/realtime.js');

const trusted = (address) => address === '172.18.0.2';
const req = ({ origin, host = 'butler.example', peer = '172.18.0.2', encrypted = false, headers = {} }) => ({
  headers: { host, ...(origin ? { origin } : {}), ...headers },
  socket: { remoteAddress: peer, encrypted },
});

describe('Socket.IO origin check (no APP_ORIGIN)', () => {
  it('compares the scheme: an https page is refused by a plain-http, untrusted-peer request', () => {
    expect(isOriginAllowed(req({ origin: 'https://butler.example', peer: '203.0.113.5' }), undefined, trusted)).toBe(false);
    expect(isOriginAllowed(req({ origin: 'http://butler.example', peer: '203.0.113.5' }), undefined, trusted)).toBe(true);
  });

  it('compares the port', () => {
    expect(isOriginAllowed(req({ origin: 'http://butler.example:8080' }), undefined, () => false)).toBe(false);
    expect(isOriginAllowed(req({ host: 'butler.example:2626', origin: 'http://butler.example:2626' }), undefined, () => false)).toBe(true);
  });

  it('uses the socket\'s own scheme when TLS terminates at the Node server', () => {
    expect(isOriginAllowed(req({ origin: 'https://butler.example', encrypted: true }), undefined, () => false)).toBe(true);
  });

  it('honours X-Forwarded-Proto/Host only from a trusted peer', () => {
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'butler.example' };
    const fromProxy = req({ origin: 'https://butler.example', host: '172.18.0.9:2626', headers });
    expect(isOriginAllowed(fromProxy, undefined, trusted)).toBe(true);
    const spoofed = req({ origin: 'https://butler.example', host: '172.18.0.9:2626', peer: '203.0.113.5', headers });
    expect(isOriginAllowed(spoofed, undefined, trusted)).toBe(false);
  });

  it('a spoofed forwarded header cannot legitimise a foreign origin from an untrusted peer', () => {
    const r = req({ origin: 'https://evil.example', peer: '203.0.113.5', headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } });
    expect(isOriginAllowed(r, undefined, trusted)).toBe(false);
  });

  it('still allows a missing Origin, and refuses a malformed one', () => {
    expect(isOriginAllowed(req({}), undefined, trusted)).toBe(true);
    expect(isOriginAllowed(req({ origin: 'not a url' }), undefined, trusted)).toBe(false);
  });

  it('APP_ORIGIN still pins the exact origin', () => {
    expect(isOriginAllowed(req({ origin: 'https://butler.example' }), 'https://butler.example', trusted)).toBe(true);
    expect(isOriginAllowed(req({ origin: 'http://butler.example' }), 'https://butler.example', trusted)).toBe(false);
  });
});
