const os = require('os');
const path = require('path');
const net = require('net');

const APP_VERSION = '0.41';

// bcrypt's modular-crypt format: $2a/2b/2y$, two-digit cost, then 53 characters of salt+digest.
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const JWT_SECRET_MIN_LENGTH = 32;

// Returns a list of problems, each naming the variable but never its value (the values are
// secrets, and this text ends up in container logs).
function validateAuthEnv(env) {
  const problems = [];
  if (!env.AUTH_USERNAME) problems.push('AUTH_USERNAME is required.');
  if (!env.AUTH_PASSWORD_HASH) {
    problems.push('AUTH_PASSWORD_HASH is required.');
  } else if (!BCRYPT_HASH_PATTERN.test(env.AUTH_PASSWORD_HASH)) {
    problems.push('AUTH_PASSWORD_HASH is not a valid bcrypt hash (generate one with scripts/generate-password-hash.js).');
  }
  if (!env.JWT_SECRET) {
    problems.push('JWT_SECRET is required.');
  } else if (env.JWT_SECRET.length < JWT_SECRET_MIN_LENGTH) {
    problems.push(`JWT_SECRET is too short: use at least ${JWT_SECRET_MIN_LENGTH} random characters (e.g. openssl rand -hex 32).`);
  }
  return problems;
}

// Fail at startup, not as a 500 on the first login: the process exits non-zero.
const authProblems = validateAuthEnv(process.env);
if (authProblems.length) {
  throw new Error(`Invalid auth configuration:\n  ${authProblems.join('\n  ')}`);
}
const { JWT_SECRET, AUTH_USERNAME, AUTH_PASSWORD_HASH } = process.env;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INVOICE_BYTES = 20 * 1024 * 1024;

// The one directory processed images are stored in (and served from, via the signed /media
// route only). The default is the path the container already bind-mounts
// (/app/public/uploads), so existing deployments need no template change. Must be absolute.
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads'));
// Private scratch space for multer. Raw client bytes (images and invoice PDFs) land here, are
// validated, and are always deleted; nothing in this directory is ever served.
const UPLOAD_TMP_DIR = path.resolve(process.env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), 'butler-upload-tmp'));

// 50 megapixels (about 7000 x 7000): fits a 48 MP phone photo, and is roughly 5x below sharp's
// default of ~268 MP, which is far more than any label or product photo needs.
const MAX_IMAGE_PIXELS = 50_000_000;
// Real Coles/Woolworths invoices are a few pages (the fixtures are 2-4). Over this the upload
// is rejected rather than truncated, so a long document can't silently lose invoice lines.
const MAX_PDF_PAGES = 20;

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
  validateAuthEnv,
  APP_VERSION,
  JWT_SECRET,
  AUTH_USERNAME,
  AUTH_PASSWORD_HASH,
  MAX_IMAGE_BYTES,
  MAX_INVOICE_BYTES,
  UPLOADS_DIR,
  UPLOAD_TMP_DIR,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
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
