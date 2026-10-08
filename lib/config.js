const APP_VERSION = '0.40';

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
  validateAuthEnv,
  APP_VERSION,
  JWT_SECRET,
  AUTH_USERNAME,
  AUTH_PASSWORD_HASH,
  MAX_IMAGE_BYTES,
  MAX_INVOICE_BYTES,
  getAnthropicModel,
  PORT,
  GENERAL_API_RATE_LIMIT_MAX,
  MUTATION_RATE_LIMIT_MAX,
  LLM_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_MAX,
};
