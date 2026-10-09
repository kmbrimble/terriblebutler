const crypto = require('crypto');

// Server-side session state: a single-row `auth_state` table holding the token epoch that
// every household JWT must match (`ver` claim), plus a fingerprint of the configured login
// credential and of the JWT signing key, so that rotating AUTH_PASSWORD_HASH / AUTH_USERNAME / JWT_SECRET
// is noticed at startup.
// Bumping the epoch is the one operation that ends every household session at once.
function createAuthState(db) {
  db.prepare('INSERT OR IGNORE INTO auth_state (id, token_epoch) VALUES (1, 1)').run();

  const getEpoch = () => db.prepare('SELECT token_epoch FROM auth_state WHERE id = 1').get().token_epoch;

  // Bumps the epoch (all JWTs go stale) and revokes every device token, atomically.
  const revokeAllSessions = db.transaction(() => {
    db.prepare('UPDATE auth_state SET token_epoch = token_epoch + 1 WHERE id = 1').run();
    db.prepare('UPDATE device_tokens SET revoked = 1 WHERE revoked = 0').run();
  });

  // One-way digests; neither the bcrypt hash nor the signing key is ever stored or logged.
  function credentialFingerprint(username, passwordHash) {
    return crypto.createHash('sha256').update(`butler-credential-v1\0${username}\0${passwordHash}`).digest('hex');
  }
  // Keyed with the signing key itself and a fixed label, so the stored value is domain-separated from every
  // other use of the key (JWT signatures, the media-URL HKDF) and says nothing useful about it.
  function keyFingerprint(jwtKey) {
    return crypto.createHmac('sha256', jwtKey).update('butler/jwt-key-fingerprint/v1').digest('hex');
  }

  // Run at startup. The stored value is "<credential digest>.<key digest>". Rotating the login
  // (AUTH_USERNAME / AUTH_PASSWORD_HASH) or the JWT signing key (JWT_SECRET) means the household rotated
  // something to lock everyone out, so both are treated the same way: epoch bump plus device-token
  // revocation (a device token is not signed with the key, so only this makes a key rotation cut it off).
  // First run, and the first run after the key digest was introduced (a stored value with no ".<key>"
  // part), only record what is configured: nothing is revoked by the upgrade itself.
  // Returns 'unchanged', 'initialised' (recorded, nothing revoked), 'rotated' (login changed) or
  // 'key_rotated' (only the signing key changed); the last two have revoked every session and device.
  function syncCredentialFingerprint(username, passwordHash, jwtKey) {
    const credential = credentialFingerprint(username, passwordHash);
    const key = keyFingerprint(jwtKey);
    const current = `${credential}.${key}`;
    const stored = db.prepare('SELECT credential_fingerprint AS fp FROM auth_state WHERE id = 1').get().fp;
    if (stored === current) return 'unchanged';
    const save = db.prepare('UPDATE auth_state SET credential_fingerprint = ? WHERE id = 1');
    if (stored === null) {
      save.run(current);
      return 'initialised';
    }
    const [storedCredential, storedKey] = stored.split('.');
    if (storedCredential === credential && storedKey === undefined) {
      save.run(current); // legacy value: same login, key digest not recorded yet
      return 'initialised';
    }
    db.transaction(() => {
      revokeAllSessions();
      save.run(current);
    })();
    return storedCredential === credential ? 'key_rotated' : 'rotated';
  }

  return { getEpoch, revokeAllSessions, syncCredentialFingerprint };
}

module.exports = { createAuthState };
