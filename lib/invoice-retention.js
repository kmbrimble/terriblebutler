// Invoice imports that were uploaded but never committed or cancelled (a closed tab, a changed
// mind) would otherwise sit in the staging tables for ever, holding their duplicate-detection
// key so the same invoice could not be uploaded again. Anything still uncommitted after the
// retention period is deleted, lines first (there is no ON DELETE CASCADE). Committed imports
// are the record of what was added to stock and are never touched.
const DAY_MS = 24 * 60 * 60 * 1000;

function purgeAbandonedImports(db, retentionDays, now = Date.now()) {
  // created_at is SQLite's datetime('now'): UTC, 'YYYY-MM-DD HH:MM:SS', so it compares as text.
  const cutoff = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
  return db.transaction(() => {
    const stale = "SELECT id FROM invoice_imports WHERE status <> 'committed' AND created_at < ?";
    db.prepare(`DELETE FROM invoice_import_lines WHERE import_id IN (${stale})`).run(cutoff);
    return db.prepare(`DELETE FROM invoice_imports WHERE id IN (${stale})`).run(cutoff).changes;
  })();
}

// Runs once now and then daily. The timer is unref'd so it never keeps the process alive, and a
// failed run is logged and retried the next day rather than crashing the server.
function scheduleImportPurge(db, retentionDays, { log = console } = {}) {
  const run = () => {
    try {
      const removed = purgeAbandonedImports(db, retentionDays);
      if (removed) log.log(`[Invoices] Removed ${removed} abandoned import(s) older than ${retentionDays} days.`);
    } catch (err) {
      log.error('[Invoices] Purging abandoned imports failed:', err);
    }
  };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return timer;
}

module.exports = { purgeAbandonedImports, scheduleImportPurge };
