#!/usr/bin/env node
// One-off data migration: load a manual stocktake JSON as ground truth for quantity,
// the per-location "open" flag, reorder_threshold and is_ignored_grocery, across
// whichever locations the stocktake covers. Not wired into any route, UI or scheduler —
// run manually. Dry-run by default; pass --apply to actually write.
//
// Usage:
//   node scripts/apply-stocktake.js <stocktake.json>            # dry run, prints the diff
//   node scripts/apply-stocktake.js <stocktake.json> --apply    # writes for real
//
// Stocktake item shape: { name, open, reorder_threshold, ignored,
//   locations: [{ location, container, qty }, ...] }
//
// Matching is case-insensitive exact name against items.name. An existing item gets its
// item_locations rows for the stocktake's locations set (not incremented) plus
// reorder_threshold/is_ignored_grocery overwritten; container_details and any
// item_locations rows for locations NOT in the stocktake are left untouched. A new item
// is inserted with container_details = the entry's per-location containers, deduplicated
// and joined with " / " (the schema has no per-location container field).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

class DryRunAbort extends Error {}

function applyStocktake(db, stocktake, { dryRun = true } = {}) {
  const locByName = new Map(db.prepare('SELECT id, name FROM locations').all().map((l) => [l.name.toLowerCase(), l.id]));

  const itemsByName = new Map();
  for (const it of db.prepare('SELECT id, name FROM items').all()) {
    const key = it.name.toLowerCase();
    if (!itemsByName.has(key)) itemsByName.set(key, []);
    itemsByName.get(key).push(it.id);
  }

  // Preflight: refuse to touch anything if the input doesn't cleanly map.
  const seenInInput = new Set();
  for (const entry of stocktake) {
    if (!entry.name || !entry.locations || entry.locations.length === 0) {
      throw new Error(`Stocktake entry missing name or locations: ${JSON.stringify(entry)}`);
    }
    const key = entry.name.toLowerCase();
    if (seenInInput.has(key)) {
      throw new Error(`Duplicate stocktake entry for "${entry.name}" — the input file has this name more than once`);
    }
    seenInInput.add(key);
    for (const loc of entry.locations) {
      if (!locByName.has(String(loc.location).toLowerCase())) {
        throw new Error(`Unknown location "${loc.location}" for item "${entry.name}"`);
      }
    }
    const existing = itemsByName.get(key);
    if (existing && existing.length > 1) {
      throw new Error(`Ambiguous match: "${entry.name}" matches ${existing.length} existing items (ids ${existing.join(', ')})`);
    }
  }

  const findItemLocation = db.prepare('SELECT id, quantity, is_open FROM item_locations WHERE item_id = ? AND location_id = ?');
  const updateItemLocation = db.prepare('UPDATE item_locations SET quantity = ?, is_open = ? WHERE id = ?');
  const insertItemLocation = db.prepare('INSERT INTO item_locations (item_id, location_id, quantity, is_open) VALUES (?, ?, ?, ?)');
  const updateItem = db.prepare('UPDATE items SET reorder_threshold = ?, is_ignored_grocery = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const insertItem = db.prepare('INSERT INTO items (name, container_details, reorder_threshold, is_ignored_grocery) VALUES (?, ?, ?, ?)');
  const getItem = db.prepare('SELECT reorder_threshold, is_ignored_grocery FROM items WHERE id = ?');

  const log = [];
  let inserted = 0;
  let updated = 0;

  function runAll() {
    inserted = 0;
    updated = 0;
    log.length = 0;
    for (const entry of stocktake) {
      const isOpen = entry.open ? 1 : 0;
      const threshold = entry.reorder_threshold ?? 0;
      const ignored = entry.ignored ? 1 : 0;
      const existingIds = itemsByName.get(entry.name.toLowerCase());
      let itemId;

      if (existingIds && existingIds.length === 1) {
        itemId = existingIds[0];
        const before = getItem.get(itemId);
        updateItem.run(threshold, ignored, itemId);
        updated++;
        log.push(`UPDATE  "${entry.name}" (id ${itemId}): reorder_threshold ${before.reorder_threshold} -> ${threshold}, is_ignored_grocery ${before.is_ignored_grocery} -> ${ignored}`);
      } else {
        const container = [...new Set(entry.locations.map((l) => (l.container || '').trim()))].filter(Boolean).join(' / ');
        const info = insertItem.run(entry.name, container, threshold, ignored);
        itemId = Number(info.lastInsertRowid);
        inserted++;
        log.push(`INSERT  "${entry.name}" (new id ${itemId}): container="${container}", reorder_threshold=${threshold}, is_ignored_grocery=${ignored}`);
      }

      for (const loc of entry.locations) {
        const locationId = locByName.get(loc.location.toLowerCase());
        const row = findItemLocation.get(itemId, locationId);
        if (row) {
          updateItemLocation.run(loc.qty, isOpen, row.id);
          log.push(`  ${loc.location}: quantity ${row.quantity} -> ${loc.qty}, is_open ${row.is_open} -> ${isOpen}`);
        } else {
          insertItemLocation.run(itemId, locationId, loc.qty, isOpen);
          log.push(`  ${loc.location}: new row, quantity=${loc.qty}, is_open=${isOpen}`);
        }
      }
    }
  }

  if (dryRun) {
    // Run the real writes inside a transaction, then force a rollback — this produces
    // exactly the same before/after values a real run would, without persisting anything.
    const txn = db.transaction(() => {
      runAll();
      throw new DryRunAbort();
    });
    try {
      txn();
    } catch (e) {
      if (!(e instanceof DryRunAbort)) throw e;
    }
  } else {
    db.transaction(runAll)();
  }

  return { log, inserted, updated };
}

if (require.main === module) {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('Usage: node scripts/apply-stocktake.js <stocktake.json> [--apply]');
    process.exit(1);
  }

  const stocktake = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  const { log, inserted, updated } = applyStocktake(db, stocktake, { dryRun: !apply });
  console.log(log.join('\n'));
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'}: ${inserted} inserted, ${updated} updated, ${stocktake.length} total.`);
  db.close();
}

module.exports = { applyStocktake };
