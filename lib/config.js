const APP_VERSION = '0.32';

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

module.exports = {
  APP_VERSION,
  JWT_SECRET,
  AUTH_USERNAME,
  AUTH_PASSWORD_HASH,
  MAX_IMAGE_BYTES,
  MAX_INVOICE_BYTES,
  getAnthropicModel,
  PORT,
};
