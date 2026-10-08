const crypto = require('crypto');

// Server-side session state: a single-row `auth_state` table holding the token epoch that
// every household JWT must match (`ver` claim), plus a fingerprint of the configured login
// credential so that rotating AUTH_PASSWORD_HASH / AUTH_USERNAME is noticed at startup.
// Bumping the epoch is the one operation that ends every household session at once.
function createAuthState(db) {
  db.prepare('INSERT OR IGNORE INTO auth_state (id, token_epoch) VALUES (1, 1)').run();

  const getEpoch = () => db.prepare('SELECT token_epoch FROM auth_state WHERE id = 1').get().token_epoch;

  // Bumps the epoch (all JWTs go stale) and revokes every device token, atomically.
  const revokeAllSessions = db.transaction(() => {
    db.prepare('UPDATE auth_state SET token_epoch = token_epoch + 1 WHERE id = 1').run();
    db.prepare('UPDATE device_tokens SET revoked = 1 WHERE revoked = 0').run();
  });

  // Plain SHA-256 (not keyed with JWT_SECRET, so rotating that secret doesn't also revoke
  // device tokens). The bcrypt hash is never stored or logged, only this digest.
  function fingerprint(username, passwordHash) {
    return crypto.createHash('sha256').update(`butler-credential-v1\0${username}\0${passwordHash}`).digest('hex');
  }

  // Run at startup. First run only records the fingerprint (existing sessions and devices
  // survive the upgrade); a later change means the household rotated the login, which is
  // treated as "lock everyone out": epoch bump plus device-token revocation.
  function syncCredentialFingerprint(username, passwordHash) {
    const current = fingerprint(username, passwordHash);
    const stored = db.prepare('SELECT credential_fingerprint AS fp FROM auth_state WHERE id = 1').get().fp;
    if (stored === current) return 'unchanged';
    const save = db.prepare('UPDATE auth_state SET credential_fingerprint = ? WHERE id = 1');
    if (stored === null) {
      save.run(current);
      return 'initialised';
    }
    db.transaction(() => {
      revokeAllSessions();
      save.run(current);
    })();
    return 'rotated';
  }

  return { getEpoch, revokeAllSessions, syncCredentialFingerprint };
}

module.exports = { createAuthState };
