// Account-level brute-force backstop for POST /api/auth/login, on top of the per-client limiter.
//
// There is one shared household account, so a hard lockout after N failures would let anyone
// who can reach the login lock the family out. Instead attempts are DELAYED, never refused for
// being wrong: the first FREE attempts run at once, then each further attempt must start at
// least a growing gap (BASE_MS doubling to CAP_MS) after the previous one, however many
// clients they come from. Guessing is therefore capped at about one per CAP_MS account-wide,
// while the true password still works, merely after a wait of at most MAX_WAIT_MS. A
// successful login resets everything. Only when the wait queue is already MAX_WAIT_MS deep is
// an attempt answered 429 with Retry-After (a bounded queue is what stops held connections
// piling up). Residual trade-off: an attacker who keeps that queue full can make login slow
// or intermittently 429 for the family while they keep firing; existing sessions and device
// tokens are unaffected, and per-client limits make keeping it full expensive. A lockout would
// be strictly worse. State is in memory (resets on restart; no migration needed).
function createLoginBackoff({
  free = 3, baseMs = 500, capMs = 5000, maxWaitMs = 15000, quietMs = 15 * 60 * 1000, now = Date.now,
} = {}) {
  let attempts = 0;
  let nextAllowedAt = 0;
  let lastAt = 0;

  // Claims a slot for one attempt. Returns { waitMs } to sleep before checking the password,
  // or { retryAfterMs } if the queue is full. Counted as a failure up front so concurrent
  // attempts cannot all slip in before the first failure is recorded; recordSuccess() undoes it.
  function reserve() {
    const t = now();
    if (t - lastAt > quietMs) { attempts = 0; nextAllowedAt = 0; }
    lastAt = t;
    if (attempts < free) { attempts += 1; return { waitMs: 0 }; }
    const start = Math.max(t, nextAllowedAt);
    if (start - t > maxWaitMs) return { retryAfterMs: start - t - maxWaitMs };
    attempts += 1;
    nextAllowedAt = start + Math.min(capMs, baseMs * 2 ** (attempts - free - 1));
    return { waitMs: start - t };
  }

  function recordSuccess() {
    attempts = 0;
    nextAllowedAt = 0;
  }

  return { reserve, recordSuccess };
}

module.exports = { createLoginBackoff };
