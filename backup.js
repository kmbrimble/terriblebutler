// Nightly database backup (#17). Uses better-sqlite3's online backup API, which is WAL-safe
// (unlike a raw file copy) — same mechanism CLAUDE.md's manual pre-change backup process uses.
const fs = require('fs');
const path = require('path');

const MAX_AGE_DAYS = 14;

function backupFileName(date = new Date()) {
  return `inventory-${date.toISOString().slice(0, 10)}.db`;
}

async function runBackup(db, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, backupFileName());
  await db.backup(dest);
  pruneOldBackups(backupDir);
  return dest;
}

function pruneOldBackups(backupDir, maxAgeDays = MAX_AGE_DAYS) {
  if (!fs.existsSync(backupDir)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(backupDir)) {
    if (!/^inventory-\d{4}-\d{2}-\d{2}\.db$/.test(file)) continue;
    const full = path.join(backupDir, file);
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
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
    runBackup(db, backupDir).catch((err) => console.error('[Backup] nightly backup failed:', err));
    setTimeout(runAndReschedule, 24 * 60 * 60 * 1000);
  }
  setTimeout(runAndReschedule, msUntilNextHour(hour));
}

module.exports = { runBackup, pruneOldBackups, scheduleNightlyBackup, backupFileName };
