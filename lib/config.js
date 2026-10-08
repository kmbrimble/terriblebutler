const os = require('os');
const path = require('path');

const APP_VERSION = '0.40';

const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH;
if (!JWT_SECRET || !AUTH_USERNAME || !AUTH_PASSWORD_HASH) {
  throw new Error('AUTH_USERNAME, AUTH_PASSWORD_HASH and JWT_SECRET environment variables are required.');
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

// Read live at call time, not cached here — tests set these env vars in a beforeAll that
// runs after this module has already loaded, so caching the resolved value would freeze it
// at the default and silently ignore the test override.
const ANTHROPIC_MODEL_DEFAULT = 'claude-haiku-4-5';
function getAnthropicModel() {
  return process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULT;
}

const PORT = process.env.PORT || 2626;

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
  UPLOADS_DIR,
  UPLOAD_TMP_DIR,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  getAnthropicModel,
  PORT,
  GENERAL_API_RATE_LIMIT_MAX,
  MUTATION_RATE_LIMIT_MAX,
  LLM_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_MAX,
};
