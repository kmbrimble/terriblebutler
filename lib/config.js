const net = require('net');

const APP_VERSION = '0.40';

const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH;
if (!JWT_SECRET || !AUTH_USERNAME || !AUTH_PASSWORD_HASH) {
  throw new Error('AUTH_USERNAME, AUTH_PASSWORD_HASH and JWT_SECRET environment variables are required.');
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INVOICE_BYTES = 20 * 1024 * 1024;

// Read live at call time, not cached here — tests set these env vars in a beforeAll that
// runs after this module has already loaded, so caching the resolved value would freeze it
// at the default and silently ignore the test override.
const ANTHROPIC_MODEL_DEFAULT = 'claude-haiku-4-5';
function getAnthropicModel() {
  return process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULT;
}

const PORT = process.env.PORT || 2626;

// TRUST_PROXY (#53): which peers may vouch for the client address via X-Forwarded-For. Unset
// trusts nothing (req.ip is the socket peer). Accepts a hop count, or a comma-separated list
// of IPs/CIDRs and Express's named ranges (loopback, linklocal, uniquelocal). A hop count
// trusts the direct peer too, so anyone who can reach the port directly can spoof their
// address; an address list only honours X-Forwarded-For from the listed proxies, which is why
// it is the recommended form. Trusting everything (true, *, a /0 range) is rejected outright:
// it lets any caller choose the address the rate limiters key on.
const NAMED_TRUST_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function parseTrustProxy(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!value || value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops > 32) {
      throw new Error(`TRUST_PROXY hop count must be between 0 and 32 (got "${value}").`);
    }
    return hops || false;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (/^(true|\*)$/i.test(entry) || /\/0+$/.test(entry)) {
      throw new Error(
        `TRUST_PROXY must not trust every hop ("${value}"): that lets any client spoof its IP and ` +
        'dodge the rate limiters. Use a hop count or the proxies\' own addresses/CIDRs.'
      );
    }
    // Strict: Express's own parser would accept shorthand such as "1" as an address.
    const [addr, prefix, ...rest] = entry.split('/');
    const family = net.isIP(addr);
    const maxPrefix = family === 4 ? 32 : 128;
    const validAddress = family !== 0 && rest.length === 0 && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix));
    if (!validAddress && !NAMED_TRUST_RANGES.has(entry)) {
      throw new Error(`TRUST_PROXY entry "${entry}" is not a hop count, IP, CIDR or named range (loopback, linklocal, uniquelocal).`);
    }
  }
  return entries;
}

const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// Most parsed lines accepted from one invoice import (#55). Real Coles/Woolworths orders run
// to roughly 30-100 lines; the cap bounds the LLM work (and DB rows) one request can cause.
const INVOICE_IMPORT_MAX_LINES = Number(process.env.INVOICE_IMPORT_MAX_LINES) || 250;

// Production defaults match lib/middleware.js's historical hardcoded values. Only the e2e test
// server (test-e2e/global-setup.mjs) overrides these, to give a single shared server + single
// client IP (every test in the suite runs serially against one process, workers: 1) headroom
// no real household would ever need — dozens of specs' GETs/mutations/logins all share the same
// per-IP bucket a live deployment would only ever see from one browser at a time. Never
// overridden for the live container.
const GENERAL_API_RATE_LIMIT_MAX = Number(process.env.GENERAL_API_RATE_LIMIT_MAX) || 240;
const MUTATION_RATE_LIMIT_MAX = Number(process.env.MUTATION_RATE_LIMIT_MAX) || 90;
const LLM_RATE_LIMIT_MAX = Number(process.env.LLM_RATE_LIMIT_MAX) || 10;
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5;

module.exports = {
  APP_VERSION,
  JWT_SECRET,
  AUTH_USERNAME,
  AUTH_PASSWORD_HASH,
  MAX_IMAGE_BYTES,
  MAX_INVOICE_BYTES,
  getAnthropicModel,
  PORT,
  TRUST_PROXY,
  parseTrustProxy,
  INVOICE_IMPORT_MAX_LINES,
  GENERAL_API_RATE_LIMIT_MAX,
  MUTATION_RATE_LIMIT_MAX,
  LLM_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_MAX,
};
