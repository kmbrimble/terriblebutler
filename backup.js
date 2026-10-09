// Nightly database backup (#17). Uses better-sqlite3's online backup API, which is WAL-safe
// (unlike a raw file copy) — same mechanism CLAUDE.md's manual pre-change backup process uses.
const fs = require('fs');
const path = require('path');

const MAX_AGE_DAYS = 14;

// Backups are named to the millisecond (UTC), so a second backup on the same day sits beside
// the first instead of replacing it: inventory-2026-10-09T06-37-12-123Z.db. Older installs have
// date-only names (inventory-2026-10-09.db); pruning recognises both.
function backupFileName(date = new Date()) {
  return `inventory-${date.toISOString().replace(/[:.]/g, '-')}.db`;
}

const BACKUP_NAME = /^inventory-\d{4}-\d{2}-\d{2}(T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?)?\.db$/;

// Never overwrites: on a (same-millisecond) name clash a counter is appended.
function uniqueBackupPath(backupDir, date = new Date()) {
  const base = backupFileName(date).slice(0, -3);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- backupDir is the server's own directory next to DB_PATH and base is built from a Date, never request input
  let dest = path.join(backupDir, `${base}.db`);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same: server-chosen directory, name built from a Date and a counter
  for (let n = 1; fs.existsSync(dest); n++) dest = path.join(backupDir, `${base}-${n}.db`);
  return dest;
}

async function runBackup(db, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = uniqueBackupPath(backupDir);
  await db.backup(dest);
  pruneOldBackups(backupDir);
  return dest;
}

function pruneOldBackups(backupDir, maxAgeDays = MAX_AGE_DAYS) {
  if (!fs.existsSync(backupDir)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(backupDir)) {
    if (!BACKUP_NAME.test(file)) continue;
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `file` was just matched against BACKUP_NAME (no separators possible) from readdir of the server's own directory
    const full = path.join(backupDir, file);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch (err) {
      console.error('[Backup] failed to prune old backup %s:', file, err.message);
    }
  }
}

function msUntilNextHour(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// ponytail: setTimeout-chain scheduler, not a cron lib — good enough for one nightly job.
function scheduleNightlyBackup(db, backupDir, hour = 2) {
  function runAndReschedule() {
    // Reschedule only once this run settles, so a slow backup can never overlap the next one.
    runBackup(db, backupDir)
      .catch((err) => console.error('[Backup] nightly backup failed:', err))
      .finally(() => setTimeout(runAndReschedule, msUntilNextHour(hour))); // next local 02:00, so DST shifts do not drift it
  }
  setTimeout(runAndReschedule, msUntilNextHour(hour));
}

module.exports = { msUntilNextHour, runBackup, pruneOldBackups, scheduleNightlyBackup, backupFileName, uniqueBackupPath };
