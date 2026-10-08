const Fuse = require('fuse.js');
const { findMatch, normaliseName } = require('../item-matching');
const { parseInvoice } = require('../parsers/router');
const { classifyLinesWithLLM, matchLinesWithLLM } = require('../lib/llm-client');
const config = require('../lib/config');
const { extractPdfText, discardUpload, uploadErrorStatus } = require('../lib/uploads');
const { cleanText, finiteNumber, sendMutationError, sendServerError, ValidationError, QUANTITY_MAX } = require('../lib/domain-helpers');
const { invoiceDedupeKey } = require('../lib/invoice-dedupe');

function findImportByDedupeKey(db, key) {
  return db.prepare('SELECT id, retailer, invoice_number, invoice_date, status FROM invoice_imports WHERE dedupe_key = ?').get(key);
}

function sendDuplicateInvoice(res, existing) {
  const inProgress = existing.status !== 'committed';
  return res.status(409).json({
    code: 'duplicate_invoice',
    error: inProgress
      ? 'This invoice has already been uploaded and is waiting for review.'
      : 'This invoice has already been imported.',
    existing_import: existing,
  });
}

function getImportWithLines(db, importId) {
  const importRow = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(importId);
  if (!importRow) return null;
  const lines = db.prepare('SELECT * FROM invoice_import_lines WHERE import_id = ? ORDER BY id').all(importId);
  return { import: importRow, lines };
}

// Patching a final category/location to null is an explicit "none", not "fall back to the
// suggestion" (#46), so the matching *_cleared flag is derived from it in the same UPDATE.
const CLEARED_FLAG = { final_category_id: 'category_cleared', final_location_id: 'location_cleared' };

const INVOICE_LINE_PATCH_FIELDS = (validForeignId) => ({
  final_category_id: (v) => validForeignId('categories', v, 'Category'),
  final_location_id: (v) => validForeignId('locations', v, 'Location'),
  final_name: (v) => cleanText(v, { max: 200 }) || null,
  final_container_details: (v) => cleanText(v, { max: 500 }) || null,
  // Direct override of the match this line will commit against (fixes #40) — the review
  // UI's "merge into existing item" control patches this straight through; null means
  // "add as new", same as an unmatched line at parse time.
  matched_item_id: (v) => validForeignId('items', v, 'Matched item'),
  qty_confirmed: (v) => finiteNumber(v, { name: 'Confirmed quantity', min: 0, max: QUANTITY_MAX, allowNull: true }),
  barcode_scanned: (v) => cleanText(v, { max: 128 }) || null,
  line_status: (v) => {
    if (!['pending', 'reviewed', 'skipped'].includes(v)) throw new ValidationError('Invalid line_status');
    return v;
  },
});

function registerInvoiceRoutes(app, { db, broadcastUpdate, invoiceUpload, validForeignId, upsertItemLocationQuantity }) {
  // --- INVOICE IMPORT (Coles/Woolworths deterministic parsers + review staging) ---
  app.post('/api/invoices/import', invoiceUpload.single('invoice'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No invoice uploaded' });
    let dedupeKey = null;
    try {
      const text = await extractPdfText(req.file.path);

      const parsed = parseInvoice(text);
      if (!parsed.retailer) {
        return res.status(422).json({ error: parsed.error || 'Could not detect retailer from this PDF.' });
      }
      // A header with nothing under it can only be committed as an empty "success" (#47).
      if (parsed.lines.length === 0) {
        return res.status(422).json({ error: 'No line items could be found in this invoice, so there is nothing to import.' });
      }
      // Bounds the LLM work and staging rows one upload can cause (#55).
      if (parsed.lines.length > config.INVOICE_IMPORT_MAX_LINES) {
        return res.status(422).json({
          error: `This invoice has ${parsed.lines.length} lines, more than the ${config.INVOICE_IMPORT_MAX_LINES} an import accepts.`,
        });
      }
      // The lines come from an uploaded file, so they are validated like any client input: an
      // unbounded or negative parsed quantity would otherwise be committed as the default
      // quantity of every line the reviewer does not retype.
      try {
        parsed.lines = parsed.lines.map((line) => ({
          ...line,
          raw_name: cleanText(line.raw_name, { required: true, max: 500 }),
          qty_ordered: finiteNumber(line.qty_ordered, { name: 'Ordered quantity', min: 0, max: QUANTITY_MAX, allowNull: true }),
          qty_supplied: finiteNumber(line.qty_supplied, { name: 'Supplied quantity', min: 0, max: QUANTITY_MAX, allowNull: true }),
          unit_price: finiteNumber(line.unit_price, { name: 'Unit price', min: 0, allowNull: true }),
          line_total: finiteNumber(line.line_total, { name: 'Line total', min: 0, allowNull: true }),
        }));
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return res.status(422).json({ error: `This invoice could not be read safely: ${err.message}.` });
      }
      // The same invoice twice would add its stock and price history twice (#44). Checked before
      // any LLM spend; the UNIQUE index on dedupe_key is what actually guarantees it, and also
      // catches two uploads racing past this check.
      dedupeKey = invoiceDedupeKey(parsed.retailer, parsed.invoice_number, text);
      const duplicate = findImportByDedupeKey(db, dedupeKey);
      if (duplicate) return sendDuplicateInvoice(res, duplicate);
      const warnings = [];

      // items.location_id is a vestigial column POST /api/items deliberately never writes —
      // item_locations is the real source of truth. Only offer a location suggestion when an
      // item lives in exactly one location; split across several, it's ambiguous, so leave it
      // for the review screen.
      const singleLocationByItem = new Map(
        db.prepare(`
          SELECT item_id, location_id FROM item_locations
          WHERE item_id IN (SELECT item_id FROM item_locations GROUP BY item_id HAVING COUNT(*) = 1)
        `).all().map((r) => [r.item_id, r.location_id])
      );
      const existingItems = db.prepare('SELECT id, name, barcode, category_id FROM items').all()
        .map((item) => ({ ...item, location_id: singleLocationByItem.get(item.id) ?? null }));
      const fuse = new Fuse(existingItems, { keys: ['name'], threshold: 0.3 });
      const cats = db.prepare('SELECT id, name FROM categories').all();
      const locs = db.prepare('SELECT id, name FROM locations').all();

      const insertLine = db.prepare(`
        INSERT INTO invoice_import_lines
          (import_id, raw_name, qty_ordered, qty_supplied, unit_price, line_total, gst_applicable,
           matched_item_id, suggested_category_id, suggested_location_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Learned match memory first: a raw invoice description this household has previously
      // committed against a specific item (invoice_line_match_memory, populated at commit
      // time below) is treated exactly like an exact/barcode match — confident enough to
      // inherit category/location and skip both the deterministic pass and the LLM call
      // below. Grows with use: repeat purchases short-circuit straight to their last outcome.
      const memoryStmt = db.prepare('SELECT item_id FROM invoice_line_match_memory WHERE raw_name_key = ?');

      // Deterministic match first: an exact (or barcode) hit is confident enough to inherit
      // its item's category/location as the suggestion and record matched_item_id outright.
      // A fuzzy hit is suggestion-only — its category/location still pre-fill the review
      // screen, but matched_item_id stays null (never auto-applied — see item-matching.js).
      // Only lines with neither are classified by the LLM, in batched calls run through a small
      // concurrency pool (lib/llm-client.js) — one call per line would mean an unbounded burst
      // of paid requests for a large invoice, and awaiting them serially would mean minutes of
      // network latency for something the UI is waiting on.
      const resolved = parsed.lines.map((line) => {
        const memoryHit = memoryStmt.get(normaliseName(line.raw_name));
        const memoryItem = memoryHit ? existingItems.find((it) => it.id === memoryHit.item_id) : null;
        if (memoryItem) {
          return { line, matchedItemId: memoryItem.id, suggestedCategoryId: memoryItem.category_id, suggestedLocationId: memoryItem.location_id };
        }
        const match = findMatch(existingItems, { barcode: null, name: line.raw_name }, fuse);
        if (match.type === 'barcode' || match.type === 'exact_name') {
          return { line, matchedItemId: match.item.id, suggestedCategoryId: match.item.category_id, suggestedLocationId: match.item.location_id };
        }
        if (match.type === 'fuzzy') {
          return { line, matchedItemId: null, suggestedCategoryId: match.candidates[0].category_id, suggestedLocationId: match.candidates[0].location_id };
        }
        return { line, matchedItemId: null, needsClassify: true };
      });

      const toClassify = resolved.filter((r) => r.needsClassify);
      if (toClassify.length) {
        const { results, failed } = await classifyLinesWithLLM(toClassify.map((r) => r.line.raw_name), cats, locs);
        toClassify.forEach((r, i) => {
          r.suggestedCategoryId = results[i].category_id;
          r.suggestedLocationId = results[i].location_id;
        });
        if (failed) warnings.push(`Category and location suggestions could not be generated for ${failed} of ${toClassify.length} line(s); please set them in the review.`);
      }

      // Anything still unmatched (no exact/barcode hit — whether or not a fuzzy candidate set
      // its category/location suggestion above) goes through one batched LLM match call for
      // the whole invoice, since fuzzy string similarity can't bridge branded invoice text to
      // broad non-branded item names (fixes the #40 follow-up report). A hit here inherits its
      // item's category/location, same as an exact/barcode match.
      const stillUnmatched = resolved.filter((r) => r.matchedItemId === null);
      const llmMatches = await matchLinesWithLLM(existingItems, stillUnmatched.map((r) => r.line), {
        onFailure: () => warnings.push('Automatic matching against existing items failed; please use the review screen to merge lines into existing items.'),
      });
      llmMatches.forEach((itemId, i) => {
        if (!itemId) return;
        const item = existingItems.find((it) => it.id === itemId);
        if (!item) return;
        stillUnmatched[i].matchedItemId = itemId;
        stillUnmatched[i].suggestedCategoryId = item.category_id;
        stillUnmatched[i].suggestedLocationId = item.location_id;
      });

      // The header and every line are written together after all the async work, in one
      // transaction: a failure can never leave an empty or partial import to be reviewed.
      const stageImport = db.transaction(() => {
        const info = db.prepare(`
          INSERT INTO invoice_imports (retailer, invoice_number, invoice_date, source_filename, dedupe_key)
          VALUES (?, ?, ?, ?, ?)
        `).run(parsed.retailer, parsed.invoice_number || null, parsed.invoice_date || null, req.file.originalname, dedupeKey);
        const id = Number(info.lastInsertRowid);
        for (const r of resolved) {
          insertLine.run(
            id, r.line.raw_name, r.line.qty_ordered, r.line.qty_supplied, r.line.unit_price, r.line.line_total,
            r.line.gst_applicable ? 1 : 0, r.matchedItemId, r.suggestedCategoryId, r.suggestedLocationId
          );
        }
        return id;
      });
      const importId = stageImport();

      res.json({ ...getImportWithLines(db, importId), warnings });
    } catch (err) {
      const status = uploadErrorStatus(err);
      if (status) return res.status(status).json({ error: err.message });
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && dedupeKey) {
        const duplicate = findImportByDedupeKey(db, dedupeKey);
        if (duplicate) return sendDuplicateInvoice(res, duplicate);
      }
      sendServerError(res, err, 'Failed to import invoice');
    } finally {
      await discardUpload(req.file);
    }
  });

  app.get('/api/invoices/import/:id', (req, res) => {
    const result = getImportWithLines(db, Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Import not found' });
    res.json(result);
  });

  app.delete('/api/invoices/import/:id', (req, res) => {
    const importId = Number(req.params.id);
    const importRow = db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId);
    if (!importRow) return res.status(404).json({ error: 'Import not found' });
    if (importRow.status === 'committed') return res.status(409).json({ error: 'This import has already been committed' });

    // No ON DELETE CASCADE from invoice_import_lines to invoice_imports — lines go first.
    db.transaction(() => {
      db.prepare('DELETE FROM invoice_import_lines WHERE import_id = ?').run(importId);
      db.prepare('DELETE FROM invoice_imports WHERE id = ?').run(importId);
    })();
    res.json({ message: 'Import cancelled' });
  });

  const patchFields = INVOICE_LINE_PATCH_FIELDS(validForeignId);

  app.patch('/api/invoices/import/:id/lines/:lineId', (req, res) => {
    const importId = Number(req.params.id);
    const lineId = Number(req.params.lineId);
    const line = db.prepare('SELECT id FROM invoice_import_lines WHERE id = ? AND import_id = ?').get(lineId, importId);
    if (!line) return res.status(404).json({ error: 'Import line not found' });
    const importRow = db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId);
    if (importRow.status === 'committed') return res.status(409).json({ error: 'This import has already been committed' });

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Expected an object containing invoice-line fields' });
    }
    const updates = [];
    const values = [];
    try {
      for (const [field, validate] of Object.entries(patchFields)) {
        if (field in req.body) {
          const value = validate(req.body[field]);
          updates.push(`${field} = ?`);
          values.push(value);
          if (CLEARED_FLAG[field]) {
            updates.push(`${CLEARED_FLAG[field]} = ?`);
            values.push(value === null ? 1 : 0);
          }
        }
      }
    } catch (err) {
      return sendMutationError(res, err, 'Failed to update invoice line');
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(lineId);
    db.prepare(`UPDATE invoice_import_lines SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json(db.prepare('SELECT * FROM invoice_import_lines WHERE id = ?').get(lineId));
  });

  app.post('/api/invoices/import/:id/commit', (req, res) => {
    const importId = Number(req.params.id);
    const importRow = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(importId);
    if (!importRow) return res.status(404).json({ error: 'Import not found' });
    if (importRow.status === 'committed') return res.status(409).json({ error: 'This import has already been committed' });

    const lines = db.prepare('SELECT * FROM invoice_import_lines WHERE import_id = ?').all(importId);
    if (lines.length === 0) {
      return res.status(400).json({ error: 'This import has no lines, so there is nothing to commit. Cancel it instead.' });
    }
    if (lines.some((l) => l.line_status === 'pending')) {
      return res.status(400).json({ error: 'All lines must be reviewed or skipped before committing' });
    }

    const existingItems = db.prepare('SELECT id, name, barcode, lowest_price FROM items').all();
    const fuse = new Fuse(existingItems, { keys: ['name'], threshold: 0.3 });
    const insertItem = db.prepare(`
      INSERT INTO items (name, barcode, category_id, container_details, last_price, lowest_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const touchItem = db.prepare('UPDATE items SET last_price = ?, lowest_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const insertPriceHistory = db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)');
    const markLineMatched = db.prepare('UPDATE invoice_import_lines SET matched_item_id = ? WHERE id = ?');
    // Learns raw_name -> itemId for next time's memory lookup (POST /api/invoices/import),
    // keyed on the untouched raw invoice text regardless of any final_name edit here, since
    // that's what a future invoice's parsed line will actually look like.
    const rememberMatch = db.prepare(`
      INSERT INTO invoice_line_match_memory (raw_name_key, item_id, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(raw_name_key) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at
    `);

    let itemsAdded = 0;
    let itemsMatched = 0;
    let totalValue = 0;

    try {
      db.transaction(() => {
        for (const line of lines) {
          if (line.line_status === 'skipped') continue;

          // An explicitly cleared category/location stays cleared; only "not overridden" falls
          // back to the suggestion (#46).
          const categoryId = line.category_cleared ? null : (line.final_category_id ?? line.suggested_category_id);
          const locationId = line.location_cleared ? null : (line.final_location_id ?? line.suggested_location_id);
          const qty = line.qty_confirmed ?? line.qty_supplied ?? 0;
          const price = line.unit_price ?? 0;
          const name = line.final_name || line.raw_name;
          const containerDetails = line.final_container_details || '';

          // Reusing findMatch (rather than just trusting the staged matched_item_id) covers
          // two new lines in the same import sharing a name — the first one's just-created
          // item is picked up as an exact match for the second, same as the existing
          // /api/invoices/commit endpoint. matched_item_id is also the review screen's
          // direct match-override (fixes #40), so an explicit id here always wins.
          let matchedItem = line.matched_item_id
            ? existingItems.find((i) => i.id === line.matched_item_id) || null
            : null;
          if (!matchedItem) {
            const match = findMatch(existingItems, { barcode: line.barcode_scanned || null, name }, fuse);
            if (match.type === 'barcode' || match.type === 'exact_name') matchedItem = match.item;
          }

          let itemId;
          if (matchedItem) {
            itemId = matchedItem.id;
            let newLowest = matchedItem.lowest_price;
            if (!newLowest || price < newLowest) newLowest = price;
            touchItem.run(price, newLowest, itemId);
            matchedItem.lowest_price = newLowest;
            upsertItemLocationQuantity(itemId, locationId, 'add', qty);
            itemsMatched += 1;
          } else {
            const info = insertItem.run(name, line.barcode_scanned || null, categoryId, containerDetails, price, price);
            itemId = Number(info.lastInsertRowid);
            upsertItemLocationQuantity(itemId, locationId, 'add', qty);
            existingItems.push({ id: itemId, name, barcode: line.barcode_scanned || null, lowest_price: price });
            fuse.setCollection(existingItems);
            itemsAdded += 1;
          }
          insertPriceHistory.run(itemId, price, importRow.retailer);
          markLineMatched.run(itemId, line.id);
          rememberMatch.run(normaliseName(line.raw_name), itemId);
          totalValue += line.line_total || 0;
        }
        db.prepare("UPDATE invoice_imports SET status = 'committed' WHERE id = ?").run(importId);
      })();

      broadcastUpdate('invoice_commit', {});
      res.json({ items_added: itemsAdded, items_matched: itemsMatched, total_value: Math.round(totalValue * 100) / 100 });
    } catch (err) {
      sendServerError(res, err, 'Failed to commit invoice import');
    }
  });
}

module.exports = { registerInvoiceRoutes };
