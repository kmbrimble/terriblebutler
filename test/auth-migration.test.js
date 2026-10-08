import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { runMigrations, hasColumn, migrations } from '../db-migrations.js';
import { createAuthState } from '../lib/auth-state.js';

// A populated pre-#5 database: device_tokens without issued_by_jti, no auth_state table.
function legacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO device_tokens (token_hash, device_label) VALUES ('h1', 'Existing tablet');
  `);
  db.pragma(`user_version = ${migrations.length - 1}`);
  return db;
}

describe('session-revocation migration', () => {
  it('adds issued_by_jti and auth_state to a populated database, keeping existing devices valid', () => {
    const db = legacyDb();
    runMigrations(db, migrations, false);

    expect(hasColumn(db, 'device_tokens', 'issued_by_jti')).toBe(true);
    const row = db.prepare('SELECT * FROM device_tokens').get();
    expect(row.device_label).toBe('Existing tablet');
    expect(row.revoked).toBe(0);
    expect(row.issued_by_jti).toBeNull();

    const state = createAuthState(db);
    expect(state.getEpoch()).toBe(1);
    // First start after the upgrade records the fingerprint without revoking anything.
    expect(state.syncCredentialFingerprint('u', 'hash')).toBe('initialised');
    expect(db.prepare('SELECT revoked FROM device_tokens').get().revoked).toBe(0);
  });

  it('is idempotent when the objects already exist', () => {
    const db = legacyDb();
    db.exec('ALTER TABLE device_tokens ADD COLUMN issued_by_jti TEXT');
    db.exec('CREATE TABLE auth_state (id INTEGER PRIMARY KEY CHECK (id = 1), token_epoch INTEGER NOT NULL DEFAULT 1, credential_fingerprint TEXT)');
    expect(() => runMigrations(db, migrations, false)).not.toThrow();
  });
});
