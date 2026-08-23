const fs = require('fs');
const Fuse = require('fuse.js');
const pdfParse = require('pdf-parse');
const { PDFParse } = require('pdf-parse');
const { findMatch } = require('../item-matching');
const { validateInvoiceItems } = require('../llm-schema');
const { parseInvoice } = require('../parsers/router');
const { fetchWithOllamaFallback, extractJsonFromText, classifyLineWithLLM } = require('../lib/llm-client');
const { cleanText, finiteNumber, sendMutationError } = require('../lib/domain-helpers');
const config = require('../lib/config');

function getImportWithLines(db, importId) {
  const importRow = db.prepare('SELECT * FROM invoice_imports WHERE id = ?').get(importId);
  if (!importRow) return null;
  const lines = db.prepare('SELECT * FROM invoice_import_lines WHERE import_id = ? ORDER BY id').all(importId);
  return { import: importRow, lines };
}

const INVOICE_LINE_PATCH_FIELDS = (validForeignId) => ({
  final_category_id: (v) => validForeignId('categories', v, 'Category'),
  final_location_id: (v) => validForeignId('locations', v, 'Location'),
  qty_confirmed: (v) => finiteNumber(v, { name: 'Confirmed quantity', min: 0, allowNull: true }),
  barcode_scanned: (v) => cleanText(v, { max: 128 }) || null,
  line_status: (v) => {
    if (!['pending', 'reviewed', 'skipped'].includes(v)) throw new Error('Invalid line_status');
    return v;
  },
});

function registerInvoiceRoutes(app, { db, broadcastUpdate, invoiceUpload, validForeignId, upsertItemLocationQuantity }) {
  app.post('/api/invoices/parse', invoiceUpload.single('invoice'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No invoice uploaded' });
    }
    const llmApiUrl = config.getLlmApiUrl();
    const llmModel = config.getLlmModel();
    try {
      const dataBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(dataBuffer);
      const rawText = pdfData.text;
      const payload = {
        model: llmModel,
        messages: [
          {
            role: "user",
            content: `Parse the following supermarket invoice text. Extract items and return a JSON object with a single key "items" containing an array of objects. Each object must have keys: "name" (string, cleaned title), "container_details" (string), "quantity" (number, strict Supplied/Picked only, ignore Ordered/Out of Stock), "price" (number, unit price), "vendor" (string). Output strictly as JSON.\n\n${rawText}`
          }
        ],
        response_format: { type: "json_object" }
      };
      const response = await fetchWithOllamaFallback(llmApiUrl, payload);
      const data = await response.json();
      const content = data.choices[0].message.content;
      let parsedJson;
      try {
        parsedJson = extractJsonFromText(content);
      } catch (e) {
        parsedJson = { items: [] };
      }
      const { items, errors } = validateInvoiceItems(parsedJson);
      if (errors.length) console.warn('[Invoice Parser] Dropped LLM items failing schema validation:', errors);
      res.json(items);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to parse invoice: ' + err.message });
    } finally {
      if (req.file) fs.unlink(req.file.path, () => {});
    }
  });

  app.post('/api/invoices/commit', (req, res) => {
    const itemsToCommit = req.body.items;
    if (!Array.isArray(itemsToCommit)) {
      return res.status(400).json({ error: 'Expected an array of items' });
    }
    const existingItems = db.prepare('SELECT id, name, barcode, lowest_price FROM items').all();
    const fuse = new Fuse(existingItems, {
      keys: ['name'],
      threshold: 0.3
    });
    const insertItem = db.prepare(`
      INSERT INTO items (name, barcode, container_details, last_price, lowest_price)
      VALUES (?, ?, ?, ?, ?)
    `);
    const touchItem = db.prepare('UPDATE items SET last_price = ?, lowest_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const insertPriceHistory = db.prepare(`
      INSERT INTO price_history (item_id, price, vendor)
      VALUES (?, ?, ?)
    `);
    try {
      db.transaction(() => {
        for (const item of itemsToCommit) {
          // Match hierarchy: barcode > exact normalised name > user-confirmed (matchDecision) >
          // fuzzy (suggestion only, never auto-applied). See item-matching.js.
          let matchedItem = null;
          if (item.matchDecision && item.matchDecision !== 'new') {
            matchedItem = existingItems.find((i) => i.id === Number(item.matchDecision)) || null;
          } else if (item.matchDecision !== 'new') {
            const match = findMatch(existingItems, { barcode: item.barcode || null, name: item.name }, fuse);
            if (match.type === 'barcode' || match.type === 'exact_name') matchedItem = match.item;
          }

          const locationId = item.location_id ? parseInt(item.location_id) : null;
          let itemId;
          if (matchedItem) {
            itemId = matchedItem.id;
            let newLowest = matchedItem.lowest_price;
            if (newLowest === 0 || item.price < newLowest) {
              newLowest = item.price;
            }
            touchItem.run(item.price, newLowest, itemId);
            matchedItem.lowest_price = newLowest;
            upsertItemLocationQuantity(itemId, locationId, 'add', item.quantity);
          } else {
            const info = insertItem.run(
              item.name,
              item.barcode || null,
              item.container_details || '',
              item.price,
              item.price
            );
            itemId = info.lastInsertRowid;
            upsertItemLocationQuantity(itemId, locationId, 'add', item.quantity);
            // Update the in-memory match set so later line items in this same commit can
            // match against items just inserted, without re-querying the database.
            existingItems.push({ id: itemId, name: item.name, barcode: item.barcode || null, lowest_price: item.price });
            fuse.setCollection(existingItems);
          }
          insertPriceHistory.run(itemId, item.price, item.vendor);
        }
      })();
      broadcastUpdate('invoice_commit', {});
      res.json({ message: 'Invoice items committed successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to commit invoice: ' + err.message });
    }
  });

  // --- INVOICE IMPORT (Coles/Woolworths deterministic parsers + review staging) ---
  app.post('/api/invoices/import', invoiceUpload.single('invoice'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No invoice uploaded' });
    try {
      const pdfParser = new PDFParse({ data: fs.readFileSync(req.file.path) });
      const { text } = await pdfParser.getText();
      await pdfParser.destroy();

      const parsed = parseInvoice(text);
      if (!parsed.retailer) {
        return res.status(422).json({ error: parsed.error || 'Could not detect retailer from this PDF.' });
      }

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

      const importInfo = db.prepare(`
        INSERT INTO invoice_imports (retailer, invoice_number, invoice_date, source_filename)
        VALUES (?, ?, ?, ?)
      `).run(parsed.retailer, parsed.invoice_number || null, parsed.invoice_date || null, req.file.originalname);
      const importId = Number(importInfo.lastInsertRowid);

      const insertLine = db.prepare(`
        INSERT INTO invoice_import_lines
          (import_id, raw_name, qty_ordered, qty_supplied, unit_price, line_total, gst_applicable,
           matched_item_id, suggested_category_id, suggested_location_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Deterministic match first: an exact (or barcode) hit is confident enough to inherit
      // its item's category/location as the suggestion and record matched_item_id outright.
      // A fuzzy hit is suggestion-only — its category/location still pre-fill the review
      // screen, but matched_item_id stays null (never auto-applied — see item-matching.js).
      // Only lines with neither get an LLM classify call, and those run in parallel — with a
      // 32-line invoice, awaiting them one at a time would mean worst-case minutes of serial
      // network latency for something the UI is waiting on.
      const resolved = parsed.lines.map((line) => {
        const match = findMatch(existingItems, { barcode: null, name: line.raw_name }, fuse);
        if (match.type === 'barcode' || match.type === 'exact_name') {
          return { line, matchedItemId: match.item.id, suggestedCategoryId: match.item.category_id, suggestedLocationId: match.item.location_id };
        }
        if (match.type === 'fuzzy') {
          return { line, matchedItemId: null, suggestedCategoryId: match.candidates[0].category_id, suggestedLocationId: match.candidates[0].location_id };
        }
        return { line, matchedItemId: null, needsClassify: true };
      });

      await Promise.all(resolved.filter((r) => r.needsClassify).map(async (r) => {
        const classified = await classifyLineWithLLM(r.line.raw_name, cats, locs);
        r.suggestedCategoryId = classified.category_id;
        r.suggestedLocationId = classified.location_id;
      }));

      for (const r of resolved) {
        insertLine.run(
          importId, r.line.raw_name, r.line.qty_ordered, r.line.qty_supplied, r.line.unit_price, r.line.line_total,
          r.line.gst_applicable ? 1 : 0, r.matchedItemId, r.suggestedCategoryId, r.suggestedLocationId
        );
      }

      res.json(getImportWithLines(db, importId));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to import invoice: ' + err.message });
    } finally {
      if (req.file) fs.unlink(req.file.path, () => {});
    }
  });

  app.get('/api/invoices/import/:id', (req, res) => {
    const result = getImportWithLines(db, Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Import not found' });
    res.json(result);
  });

  const patchFields = INVOICE_LINE_PATCH_FIELDS(validForeignId);

  app.patch('/api/invoices/import/:id/lines/:lineId', (req, res) => {
    const importId = Number(req.params.id);
    const lineId = Number(req.params.lineId);
    const line = db.prepare('SELECT id FROM invoice_import_lines WHERE id = ? AND import_id = ?').get(lineId, importId);
    if (!line) return res.status(404).json({ error: 'Import line not found' });
    const importRow = db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(importId);
    if (importRow.status === 'committed') return res.status(409).json({ error: 'This import has already been committed' });

    const updates = [];
    const values = [];
    try {
      for (const [field, validate] of Object.entries(patchFields)) {
        if (field in req.body) {
          updates.push(`${field} = ?`);
          values.push(validate(req.body[field]));
        }
      }
    } catch (err) {
      return sendMutationError(res, err);
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
    if (lines.some((l) => l.line_status === 'pending')) {
      return res.status(400).json({ error: 'All lines must be reviewed or skipped before committing' });
    }

    const existingItems = db.prepare('SELECT id, name, barcode, lowest_price FROM items').all();
    const fuse = new Fuse(existingItems, { keys: ['name'], threshold: 0.3 });
    const insertItem = db.prepare(`
      INSERT INTO items (name, barcode, category_id, last_price, lowest_price)
      VALUES (?, ?, ?, ?, ?)
    `);
    const touchItem = db.prepare('UPDATE items SET last_price = ?, lowest_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const insertPriceHistory = db.prepare('INSERT INTO price_history (item_id, price, vendor) VALUES (?, ?, ?)');
    const markLineMatched = db.prepare('UPDATE invoice_import_lines SET matched_item_id = ? WHERE id = ?');

    let itemsAdded = 0;
    let itemsMatched = 0;
    let totalValue = 0;

    try {
      db.transaction(() => {
        for (const line of lines) {
          if (line.line_status === 'skipped') continue;

          const categoryId = line.final_category_id ?? line.suggested_category_id;
          const locationId = line.final_location_id ?? line.suggested_location_id;
          const qty = line.qty_confirmed ?? line.qty_supplied ?? 0;
          const price = line.unit_price ?? 0;

          // Reusing findMatch (rather than just trusting the staged matched_item_id) covers
          // two new lines in the same import sharing a name — the first one's just-created
          // item is picked up as an exact match for the second, same as the existing
          // /api/invoices/commit endpoint.
          let matchedItem = line.matched_item_id
            ? existingItems.find((i) => i.id === line.matched_item_id) || null
            : null;
          if (!matchedItem) {
            const match = findMatch(existingItems, { barcode: line.barcode_scanned || null, name: line.raw_name }, fuse);
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
            const info = insertItem.run(line.raw_name, line.barcode_scanned || null, categoryId, price, price);
            itemId = Number(info.lastInsertRowid);
            upsertItemLocationQuantity(itemId, locationId, 'add', qty);
            existingItems.push({ id: itemId, name: line.raw_name, barcode: line.barcode_scanned || null, lowest_price: price });
            fuse.setCollection(existingItems);
            itemsAdded += 1;
          }
          insertPriceHistory.run(itemId, price, importRow.retailer);
          markLineMatched.run(itemId, line.id);
          totalValue += line.line_total || 0;
        }
        db.prepare("UPDATE invoice_imports SET status = 'committed' WHERE id = ?").run(importId);
      })();

      broadcastUpdate('invoice_commit', {});
      res.json({ items_added: itemsAdded, items_matched: itemsMatched, total_value: Math.round(totalValue * 100) / 100 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to commit invoice import: ' + err.message });
    }
  });
}

module.exports = { registerInvoiceRoutes };
