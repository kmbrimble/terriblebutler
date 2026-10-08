import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import path from 'path';
import request from 'supertest';
import './setup.js';
import { api, clearInvoiceImports } from './setup.js';
import { loadFreshApp } from './fresh-app.js';
import pkg from '../server.js';

const { app, db } = pkg;

vi.setConfig({ testTimeout: 30000 });

const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
const COLES_PDF = path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf');

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
});

beforeEach(() => {
  clearInvoiceImports();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const importPdf = (a, file) => api(a).post('/api/invoices/import').attach('invoice', file);
const importRows = () => db.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n;

describe('stock quantity bounds (#42)', () => {
  it('the database itself refuses negative stock', () => {
    const id = db.prepare("INSERT INTO items (name) VALUES ('Trigger probe')").run().lastInsertRowid;
    expect(() => db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, NULL, -1)').run(id)).toThrow(/negative/);
    db.prepare('INSERT INTO item_locations (item_id, location_id, quantity) VALUES (?, NULL, 1)').run(id);
    expect(() => db.prepare('UPDATE item_locations SET quantity = -5 WHERE item_id = ?').run(id)).toThrow(/negative/);
  });

  it('the quantity bound applies to item routes too', async () => {
    const created = await api(app).post('/api/items').send({ name: 'Bound probe', quantity: 1 });
    expect(created.status).toBe(201);
    const res = await api(app).patch(`/api/items/${created.body.id}/quantity`).send({ action: 'add', amount: 1000001 });
    expect(res.status).toBe(400);
    expect((await api(app).post('/api/items').send({ name: 'Too many', quantity: 1e9 })).status).toBe(400);
  });
});

describe('staging transaction (#43)', () => {
  it('a failure part-way through writing lines leaves neither header nor lines', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const before = importRows();
    const linesBefore = db.prepare('SELECT COUNT(*) AS n FROM invoice_import_lines').get().n;
    db.exec(`CREATE TEMP TRIGGER fail_third_line BEFORE INSERT ON invoice_import_lines
      WHEN (SELECT COUNT(*) FROM invoice_import_lines) >= ${linesBefore + 2} BEGIN SELECT RAISE(ABORT, 'forced'); END`);
    try {
      expect((await importPdf(app, COLES_PDF)).status).toBe(500);
    } finally {
      db.exec('DROP TRIGGER fail_third_line');
    }
    expect(importRows()).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_import_lines').get().n).toBe(linesBefore);
  });
});

describe('duplicate invoice detection (#44)', () => {
  it('refuses the same invoice twice with a 409 pointing at the existing import, before spending on the LLM', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const first = await importPdf(app, COLES_PDF);
    expect(first.status).toBe(200);
    const calls = global.fetch.mock.calls.length;

    const second = await importPdf(app, COLES_PDF);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('duplicate_invoice');
    expect(second.body.existing_import).toMatchObject({ id: first.body.import.id, status: 'in_progress' });
    expect(second.body.error).toMatch(/waiting for review/);
    expect(global.fetch.mock.calls.length).toBe(calls);
    expect(importRows()).toBe(1);
  });

  it('keeps refusing after the first import was committed, and says so', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const first = await importPdf(app, COLES_PDF);
    db.prepare("UPDATE invoice_import_lines SET line_status = 'skipped' WHERE import_id = ?").run(first.body.import.id);
    expect((await api(app).post(`/api/invoices/import/${first.body.import.id}/commit`)).status).toBe(200);

    const second = await importPdf(app, COLES_PDF);
    expect(second.status).toBe(409);
    expect(second.body.existing_import.status).toBe('committed');
    expect(second.body.error).toMatch(/already been imported/);
  });

  it('allows the invoice again once the pending import has been cancelled', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const first = await importPdf(app, COLES_PDF);
    expect((await api(app).delete(`/api/invoices/import/${first.body.import.id}`)).status).toBe(200);
    expect((await importPdf(app, COLES_PDF)).status).toBe(200);
  });

  it('treats different invoices from the same retailer as distinct', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    expect((await importPdf(app, COLES_PDF)).status).toBe(200);
    expect((await importPdf(app, WOOLWORTHS_PDF)).status).toBe(200);
  });

  it('is enforced by the database: two uploads racing past the pre-check cannot both stage', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const first = await importPdf(app, COLES_PDF);
    expect(first.status).toBe(200);
    // Blind the pre-check once, as if the other upload had not committed yet.
    const realPrepare = db.prepare.bind(db);
    let blinded = false;
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (!blinded && /FROM invoice_imports WHERE dedupe_key = \?/.test(sql)) {
        blinded = true;
        return { get: () => undefined };
      }
      return realPrepare(sql);
    });

    const second = await importPdf(app, COLES_PDF);

    expect(blinded).toBe(true);
    expect(second.status).toBe(409);
    expect(second.body.existing_import.id).toBe(first.body.import.id);
    expect(importRows()).toBe(1);
  });

  describe('with no parsed invoice number', () => {
    const noNumber = () => loadFreshApp({ INVOICE_IMPORT_MAX_LINES: undefined }, {
      beforeLoad(req) {
        const router = req('../parsers/router.js');
        const real = router.parseInvoice;
        router.parseInvoice = (text) => ({ ...real(text), invoice_number: null });
      },
    });

    it('falls back to the content of the PDF: the same file is refused, a different one is not', async () => {
      const { app: fresh, db: freshDb } = noNumber();
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
      clearInvoiceImports();
      const first = await importPdf(fresh, COLES_PDF);
      expect(first.status).toBe(200);
      expect(freshDb.prepare('SELECT dedupe_key FROM invoice_imports').get().dedupe_key).toMatch(/^coles\|sha256:[0-9a-f]{64}$/);

      expect((await importPdf(fresh, COLES_PDF)).status).toBe(409);
      expect((await importPdf(fresh, WOOLWORTHS_PDF)).status).toBe(200);
    });
  });
});

describe('zero-line invoices (#47)', () => {
  it('refuses to import an invoice that parses to no lines, staging nothing', async () => {
    const { app: fresh, db: freshDb } = loadFreshApp({ INVOICE_IMPORT_MAX_LINES: undefined }, {
      beforeLoad(req) {
        const router = req('../parsers/router.js');
        const real = router.parseInvoice;
        router.parseInvoice = (text) => ({ ...real(text), lines: [] });
      },
    });
    clearInvoiceImports();
    const res = await importPdf(fresh, COLES_PDF);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No line items/);
    expect(freshDb.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n).toBe(0);
  });

  it('refuses to commit an import that has no lines', async () => {
    const id = db.prepare("INSERT INTO invoice_imports (retailer, invoice_number) VALUES ('coles', 'EMPTY')").run().lastInsertRowid;
    const res = await api(app).post(`/api/invoices/import/${id}/commit`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no lines/i);
    expect(db.prepare('SELECT status FROM invoice_imports WHERE id = ?').get(id).status).toBe('in_progress');
  });
});

describe('explicitly cleared category/location (#46)', () => {
  async function stagedLine() {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const res = await importPdf(app, COLES_PDF);
    const importId = res.body.import.id;
    const line = res.body.lines.find((l) => l.matched_item_id === null);
    db.prepare("INSERT OR IGNORE INTO categories (name) VALUES ('Integrity A'), ('Integrity B')").run();
    const cat = db.prepare("SELECT id FROM categories WHERE name = 'Integrity A'").get().id;
    const loc = db.prepare('SELECT id FROM locations LIMIT 1').get().id;
    db.prepare('UPDATE invoice_import_lines SET suggested_category_id = ?, suggested_location_id = ? WHERE id = ?').run(cat, loc, line.id);
    db.prepare("UPDATE invoice_import_lines SET line_status = 'skipped' WHERE import_id = ? AND id != ?").run(importId, line.id);
    db.prepare("UPDATE invoice_import_lines SET line_status = 'reviewed' WHERE id = ?").run(line.id);
    const patch = (body) => api(app).patch(`/api/invoices/import/${importId}/lines/${line.id}`).send(body);
    const commit = async () => {
      expect((await api(app).post(`/api/invoices/import/${importId}/commit`)).status).toBe(200);
      const l = db.prepare('SELECT matched_item_id FROM invoice_import_lines WHERE id = ?').get(line.id);
      return {
        item: db.prepare('SELECT category_id FROM items WHERE id = ?').get(l.matched_item_id),
        stock: db.prepare('SELECT location_id FROM item_locations WHERE item_id = ?').get(l.matched_item_id),
      };
    };
    return { cat, loc, patch, commit, line };
  }

  it('without an override the suggestion is used', async () => {
    const { cat, loc, commit } = await stagedLine();
    const { item, stock } = await commit();
    expect(item.category_id).toBe(cat);
    expect(stock.location_id).toBe(loc);
  });

  it('clearing the category and location keeps them cleared at commit instead of reverting to the suggestion', async () => {
    const { patch, commit } = await stagedLine();
    const res = await patch({ final_category_id: null, final_location_id: '' });
    expect(res.body).toMatchObject({ final_category_id: null, category_cleared: 1, final_location_id: null, location_cleared: 1 });
    const { item, stock } = await commit();
    expect(item.category_id).toBeNull();
    expect(stock.location_id).toBeNull();
  });

  it('choosing a value after clearing un-clears it', async () => {
    const { patch, commit } = await stagedLine();
    const other = db.prepare("SELECT id FROM categories WHERE name = 'Integrity B'").get().id;
    await patch({ final_category_id: null });
    const res = await patch({ final_category_id: other });
    expect(res.body).toMatchObject({ final_category_id: other, category_cleared: 0 });
    expect((await commit()).item.category_id).toBe(other);
  });

  it('patching unrelated fields leaves the flags alone', async () => {
    const { patch } = await stagedLine();
    await patch({ final_category_id: null });
    const res = await patch({ line_status: 'reviewed' });
    expect(res.body.category_cleared).toBe(1);
  });
});

describe('import line quantity bound (#42)', () => {
  it('rejects a confirmed quantity above the maximum', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const res = await importPdf(app, COLES_PDF);
    const line = res.body.lines[0];
    const patch = (qty) => api(app).patch(`/api/invoices/import/${res.body.import.id}/lines/${line.id}`).send({ qty_confirmed: qty });
    expect((await patch(1000001)).status).toBe(400);
    expect((await patch(-1)).status).toBe(400);
    expect((await patch(12)).status).toBe(200);
  });
});

describe('review follow-ups', () => {
  it.each(['1abc', '1.9', '1e2', -1, 0, {}])('a malformed foreign id %j is rejected, not coerced to another row', async (bad) => {
    const res = await api(app).post('/api/items').send({ name: 'Bad id', location_id: bad });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Location/);
  });

  it('a non-object PATCH body is a 400, not a 500', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const res = await importPdf(app, COLES_PDF);
    const url = `/api/invoices/import/${res.body.import.id}/lines/${res.body.lines[0].id}`;
    const patched = await api(app).patch(url).set('Content-Type', 'application/json').send('null');
    expect(patched.status).toBe(400);
  });
});

describe('parsed line values are validated (#42)', () => {
  it.each([
    ['qty_supplied', -5],
    ['qty_supplied', 1000001],
    ['unit_price', -1],
  ])('rejects an invoice whose parsed %s is %s, staging nothing', async (field, value) => {
    const { app: fresh, db: freshDb } = loadFreshApp({ INVOICE_IMPORT_MAX_LINES: undefined }, {
      beforeLoad(req) {
        const router = req('../parsers/router.js');
        const real = router.parseInvoice;
        router.parseInvoice = (text) => {
          const parsed = real(text);
          return { ...parsed, lines: parsed.lines.map((l, i) => (i === 0 ? { ...l, [field]: value } : l)) };
        };
      },
    });
    clearInvoiceImports();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('unreachable'));
    const res = await importPdf(fresh, COLES_PDF);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/could not be read safely/);
    expect(freshDb.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n).toBe(0);
  });
});
