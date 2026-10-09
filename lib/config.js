const os = require('os');
const path = require('path');
const net = require('net');

const APP_VERSION = '0.45';

// bcrypt's modular-crypt format: $2a/2b/2y$, two-digit cost, then 53 characters of salt+digest.
// The cost is bounded: below 10 is too cheap to resist offline cracking (scripts/generate-password-hash.js
// uses 10), and bcrypt itself defines nothing above 31.
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const BCRYPT_MIN_COST = 10;
const BCRYPT_MAX_COST = 31;
function isAcceptableBcryptHash(hash) {
  const match = BCRYPT_HASH_PATTERN.exec(hash);
  return Boolean(match) && Number(match[1]) >= BCRYPT_MIN_COST && Number(match[1]) <= BCRYPT_MAX_COST;
}
// JWT_SECRET must be machine-generated: hex, whole bytes, at least 32 bytes (64 characters), as
// `openssl rand -hex 32` prints. The decoded bytes are the key material, so a human-chosen
// passphrase (low entropy, and different bytes from what it looks like) is refused outright.
const JWT_SECRET_PATTERN = /^(?:[0-9a-fA-F]{2}){32,}$/;

// Returns a list of problems, each naming the variable but never its value (the values are
// secrets, and this text ends up in container logs).
function validateAuthEnv(env) {
  const problems = [];
  if (!env.AUTH_USERNAME) problems.push('AUTH_USERNAME is required.');
  if (!env.AUTH_PASSWORD_HASH) {
    problems.push('AUTH_PASSWORD_HASH is required.');
  } else if (!isAcceptableBcryptHash(env.AUTH_PASSWORD_HASH)) {
    problems.push(`AUTH_PASSWORD_HASH is not a valid bcrypt hash with a cost of ${BCRYPT_MIN_COST}-${BCRYPT_MAX_COST} (generate one with scripts/generate-password-hash.js).`);
  }
  if (!env.JWT_SECRET) {
    problems.push('JWT_SECRET is required.');
  } else if (!JWT_SECRET_PATTERN.test(env.JWT_SECRET)) {
    problems.push('JWT_SECRET must be at least 64 hexadecimal characters (32 random bytes), e.g. the output of: openssl rand -hex 32');
  }
  return problems;
}

// Fail at startup, not as a 500 on the first login: the process exits non-zero.
const authProblems = validateAuthEnv(process.env);
if (authProblems.length) {
  throw new Error(`Invalid auth configuration:\n  ${authProblems.join('\n  ')}`);
}
const { AUTH_USERNAME, AUTH_PASSWORD_HASH } = process.env;
// The decoded bytes of JWT_SECRET: the HMAC key for JWTs and the input keying material for the
// media-URL key (lib/uploads.js). The hex string itself is never used as a key.
const JWT_KEY = Buffer.from(process.env.JWT_SECRET, 'hex');


// Writable-path rules shared with docker-entrypoint.sh (which chowns these as root, so it
// must refuse anything odd). Same checks, same order; test/entrypoint.test.js runs both over one
// table of cases. Form rules always apply; containment applies when WRITABLE_ROOT is set (the
// Dockerfile sets it to /app — tests and local runs legitimately use other directories).
const CODE_DIRS = ['node_modules', 'lib', 'routes', 'parsers', 'scripts', 'client'];

function checkWritablePath(name, value, root) {
  if (!value) return `${name} is empty.`;
  if (!value.startsWith('/')) return `${name} must be an absolute path.`;
  if (/[^A-Za-z0-9._/-]|\/\/|\/\.\.?(\/|$)|\/$/.test(value)) {
    return `${name} must be a normalised path of letters, digits, '.', '_' and '-' (no '//', '.', '..' or trailing '/').`;
  }
  if (!root) return null;
  if (!value.startsWith(`${root}/`)) return `${name} must be inside ${root}.`;
  // `public` itself is code-adjacent (only its uploads/ child is writable), so exact match only.
  if (value === `${root}/public` || CODE_DIRS.some((dir) => value === `${root}/${dir}` || value.startsWith(`${root}/${dir}/`))) {
    return `${name} must not be inside the application code (${root}).`;
  }
  return null;
}

// Returns a list of problems, each naming the variable. Unset variables are skipped unless
// WRITABLE_ROOT is set (the container), where the entrypoint's /app defaults are checked too.
function validateStoragePaths(env, root = env.WRITABLE_ROOT) {
  const problems = [];
  const dirs = {};
  const check = (name, value) => {
    if (!value) return false;
    const problem = checkWritablePath(name, value, root);
    if (problem) problems.push(problem);
    return !problem;
  };
  const dbFile = env.DB_PATH || (root ? `${root}/data/inventory.db` : '');
  if (check('DB_PATH', dbFile) && check('the DB_PATH directory', path.posix.dirname(dbFile))) {
    dirs['the DB_PATH directory'] = path.posix.dirname(dbFile);
  }
  for (const [name, value, fallback] of [['UPLOADS_DIR', env.UPLOADS_DIR, `${root}/public/uploads`], ['LOG_DIR', env.LOG_DIR, dirs['the DB_PATH directory'] && `${dirs['the DB_PATH directory']}/logs`]]) {
    if (check(name, value || (root ? fallback : ''))) dirs[name] = value || fallback;
  }
  // Overlap only matters where something chowns them (the container); local runs and tests keep
  // the database, uploads and logs side by side in one temp directory.
  // UPLOAD_TMP_DIR is swept (old files deleted) at startup, so inside the container it must not
  // be, or sit inside, any directory that holds data. The entrypoint does not touch it.
  if (env.UPLOAD_TMP_DIR) {
    const problem = checkWritablePath('UPLOAD_TMP_DIR', env.UPLOAD_TMP_DIR, undefined);
    if (problem) problems.push(problem);
    else if (root) dirs.UPLOAD_TMP_DIR = env.UPLOAD_TMP_DIR;
  }
  const entries = root ? Object.entries(dirs) : [];
  const dataDir = dirs['the DB_PATH directory'];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [a, pa] = entries[i];
      const [b, pb] = entries[j];
      // The logs may sit inside the data directory (the default), just not equal or contain it.
      if (a === 'the DB_PATH directory' && b === 'LOG_DIR' || a === 'LOG_DIR' && b === 'the DB_PATH directory') {
        const logs = a === 'LOG_DIR' ? pa : pb;
        if (`${dataDir}/`.startsWith(`${logs}/`)) problems.push('LOG_DIR must not be, or contain, the DB_PATH directory.');
        continue;
      }
      if (`${pa}/`.startsWith(`${pb}/`) || `${pb}/`.startsWith(`${pa}/`)) {
        problems.push(`${a} and ${b} must be separate directories (neither may contain the other).`);
      }
    }
  }
  return problems;
}

const storageProblems = validateStoragePaths(process.env);
if (storageProblems.length) {
  throw new Error(`Invalid storage configuration:\n  ${storageProblems.join('\n  ')}`);
}

// A positive safe integer no larger than `max`, else the fallback: a typo such as -1 or Infinity
// must not silently disable a limit.
// Plain decimal digits only: Number() would also read "1e3", "0x10" and " " (as 0).
function integerEnv(raw) {
  return typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
}
function boundedIntegerEnv(name, fallback, max, min = 1) {
  const value = integerEnv(process.env[name]);
  return value >= min && value <= max ? value : fallback;
}

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
// Hard deadline and heap ceiling for the worker thread that extracts PDF text. Real invoices read
// in well under a second; the deadline only has to stop a pathological document. Both are
// overridable (PDF_PARSE_TIMEOUT_MS, PDF_WORKER_MEMORY_MB); invalid values fall back. The heap
// ceiling has a floor of 64 MB: V8 cannot even start a worker isolate under a few MB, and that
// failure aborts the whole process rather than just the worker.
const PDF_PARSE_TIMEOUT_MS = boundedIntegerEnv('PDF_PARSE_TIMEOUT_MS', 20_000, 10 * 60_000);
const PDF_WORKER_MEMORY_MB = boundedIntegerEnv('PDF_WORKER_MEMORY_MB', 256, 4096, 64);

// Process-wide bound on the expensive per-request work (PDF text extraction, sharp decoding and
// re-encoding): at most HEAVY_WORK_CONCURRENCY run at once and HEAVY_WORK_QUEUE more may wait;
// beyond that a request is refused with 503 + Retry-After and its upload discarded. The rate
// limiters are per client; this caps what all clients together can ask of the process.
const HEAVY_WORK_CONCURRENCY = boundedIntegerEnv('HEAVY_WORK_CONCURRENCY', 2, 32);
const HEAVY_WORK_QUEUE = boundedIntegerEnv('HEAVY_WORK_QUEUE', 4, 1000, 0);

// Socket.IO connection limits (lib/realtime.js). Handshakes bypass the Express limiters, so they get
// their own: per client (same address rules as the HTTP limiters) a handshake rate per minute and
// a cap on open connections, plus one cap on open connections overall. Counted at the engine
// level, so a connection that never authenticates still counts. A household needs a handful.
const SOCKET_HANDSHAKE_RATE_LIMIT_MAX = boundedIntegerEnv('SOCKET_HANDSHAKE_RATE_LIMIT_MAX', 60, 100000);
const SOCKET_MAX_PER_CLIENT = boundedIntegerEnv('SOCKET_MAX_PER_CLIENT', 20, 10000);
const SOCKET_MAX_TOTAL = boundedIntegerEnv('SOCKET_MAX_TOTAL', 200, 100000);

// Read live at call time, not cached here — tests set these env vars in a beforeAll that
// runs after this module has already loaded, so caching the resolved value would freeze it
// at the default and silently ignore the test override.
const ANTHROPIC_MODEL_DEFAULT = 'claude-haiku-4-5';
function getAnthropicModel() {
  return process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULT;
}

// Anthropic client limits, read live like the model. The SDK's own defaults are a 10-minute
// timeout and 2 retries (so one stuck call can hold a request for 30 minutes); a phone user
// waiting on a label scan or invoice import needs a bounded answer instead. A timed-out call
// surfaces as the ordinary failure the callers already handle (label scan falls back to an empty
// result, classification/matching report `failed`, invoice parse returns a 500 with a
// correlation id). ANTHROPIC_TIMEOUT_MS: per attempt, default 45 s. ANTHROPIC_MAX_RETRIES:
// default 1 (so a call is abandoned after about 90 s at worst); 0 disables retries.
const ANTHROPIC_TIMEOUT_MS_DEFAULT = 45_000;
const ANTHROPIC_MAX_RETRIES_DEFAULT = 1;
function getAnthropicTimeoutMs() {
  const value = integerEnv(process.env.ANTHROPIC_TIMEOUT_MS);
  return value > 0 ? value : ANTHROPIC_TIMEOUT_MS_DEFAULT;
}
function getAnthropicMaxRetries() {
  const value = integerEnv(process.env.ANTHROPIC_MAX_RETRIES);
  return value >= 0 && value <= 5 ? value : ANTHROPIC_MAX_RETRIES_DEFAULT;
}

// 0 is allowed (any free port; the tests use it). An invalid value falls back like every other integer setting.
const PORT = boundedIntegerEnv('PORT', 2626, 65535, 0);

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

// Uncommitted invoice imports older than this are deleted (startup + daily), which also frees
// their duplicate-detection key. Committed imports are history and are never deleted.
const INVOICE_IMPORT_RETENTION_DAYS = boundedIntegerEnv('INVOICE_IMPORT_RETENTION_DAYS', 30, 3650);

// Most existing items offered to the LLM matcher in one invoice import (#55 follow-up). An
// inventory this size or smaller is sent whole; a larger one is narrowed to the items most
// related to the invoice's lines (item-matching.js selectMatchCandidates). With names cut to
// 120 characters and line text to 200 (lib/llm-client.js) the prompt stays near 100 KB worst case.
const INVOICE_MATCH_MAX_ITEMS = boundedIntegerEnv('INVOICE_MATCH_MAX_ITEMS', 400, 2000);

const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// Most parsed lines accepted from one invoice import (#55). Real Coles/Woolworths orders run
// to roughly 30-100 lines; the cap bounds the LLM work (and DB rows) one request can cause.
const INVOICE_IMPORT_MAX_LINES = boundedIntegerEnv('INVOICE_IMPORT_MAX_LINES', 250, 1000);

// Production defaults match lib/middleware.js's historical hardcoded values. Only the e2e test
// server (test-e2e/global-setup.mjs) overrides these, to give a single shared server + single
// client IP (every test in the suite runs serially against one process, workers: 1) headroom
// no real household would ever need — dozens of specs' GETs/mutations/logins all share the same
// per-IP bucket a live deployment would only ever see from one browser at a time. Never
// overridden for the live container.
const GENERAL_API_RATE_LIMIT_MAX = boundedIntegerEnv('GENERAL_API_RATE_LIMIT_MAX', 240, 100000);
const MUTATION_RATE_LIMIT_MAX = boundedIntegerEnv('MUTATION_RATE_LIMIT_MAX', 90, 100000);
const LLM_RATE_LIMIT_MAX = boundedIntegerEnv('LLM_RATE_LIMIT_MAX', 10, 100000);
const LOGIN_RATE_LIMIT_MAX = boundedIntegerEnv('LOGIN_RATE_LIMIT_MAX', 5, 100000);

module.exports = {
  validateAuthEnv,
  validateStoragePaths,
  APP_VERSION,
  JWT_KEY,
  AUTH_USERNAME,
  AUTH_PASSWORD_HASH,
  MAX_IMAGE_BYTES,
  MAX_INVOICE_BYTES,
  UPLOADS_DIR,
  UPLOAD_TMP_DIR,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  PDF_PARSE_TIMEOUT_MS,
  PDF_WORKER_MEMORY_MB,
  HEAVY_WORK_CONCURRENCY,
  HEAVY_WORK_QUEUE,
  SOCKET_HANDSHAKE_RATE_LIMIT_MAX,
  SOCKET_MAX_PER_CLIENT,
  SOCKET_MAX_TOTAL,
  getAnthropicModel,
  getAnthropicTimeoutMs,
  getAnthropicMaxRetries,
  PORT,
  TRUST_PROXY,
  parseTrustProxy,
  INVOICE_IMPORT_MAX_LINES,
  INVOICE_MATCH_MAX_ITEMS,
  INVOICE_IMPORT_RETENTION_DAYS,
  GENERAL_API_RATE_LIMIT_MAX,
  MUTATION_RATE_LIMIT_MAX,
  LLM_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_MAX,
};
