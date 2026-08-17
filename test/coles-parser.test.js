import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import { parseColes } from '../parsers/coles.js';

let text;

beforeAll(async () => {
  const buf = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf'));
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  text = result.text;
  await parser.destroy();
});

describe('parseColes', () => {
  it('extracts invoice_number and invoice_date', () => {
    const result = parseColes(text);
    expect(result.invoice_number).toBe('262486548');
    expect(result.invoice_date).toBe('2026-07-17');
  });

  it('parses the exact expected line count, excluding out-of-stock rows', () => {
    const result = parseColes(text);
    expect(result.lines).toHaveLength(30);
  });

  it('spot-checks a non-GST line', () => {
    const result = parseColes(text);
    const line = result.lines.find((l) => l.raw_name === 'ABC Sweet Soy Sauce 620mL');
    expect(line).toMatchObject({
      qty_ordered: 1,
      qty_supplied: 1,
      unit_price: 5.3,
      line_total: 5.3,
      gst_applicable: false,
    });
  });

  it('spot-checks a GST-applicable line and strips the "%" prefix', () => {
    const result = parseColes(text);
    const line = result.lines.find((l) => l.raw_name === 'Coles Crystallised Ginger 150g');
    expect(line).toMatchObject({
      qty_ordered: 1,
      qty_supplied: 1,
      unit_price: 3.0,
      line_total: 3.0,
      gst_applicable: true,
    });
  });

  it('parses a line from a page-2 category continuation', () => {
    const result = parseColes(text);
    const line = result.lines.find((l) => l.raw_name === "Coles I'm Perfect Sweet Potato 1.5kg");
    expect(line).toMatchObject({
      qty_ordered: 2,
      qty_supplied: 2,
      unit_price: 4.9,
      line_total: 9.8,
      gst_applicable: false,
    });
  });

  it('cleans up escaped apostrophes in product names', () => {
    const result = parseColes(text);
    const names = result.lines.map((l) => l.raw_name);
    expect(names).toContain("CC's Nacho Cheese Corn Chips 175g");
    expect(names).toContain("Coles I'm Perfect Sweet Potato 1.5kg");
    expect(names.some((n) => n.includes("''"))).toBe(false);
  });

  it('excludes the known out-of-stock rows entirely', () => {
    const result = parseColes(text);
    const names = result.lines.map((l) => l.raw_name);
    expect(names).not.toContain('Coles Chocolate Dairy Dessert 12 Pack 1.2kg');
    expect(names).not.toContain('Homestyle Country Bread Cafe White Thick 850g');
    // The non-out-of-stock sibling with a near-identical name must still be present.
    expect(names).toContain('Homestyle Country Bread Cafe White 850g');
  });

  it('excludes category header and column header rows', () => {
    const result = parseColes(text);
    const names = result.lines.map((l) => l.raw_name);
    for (const category of ['Pantry', 'Health & Beauty', 'Fruit & Vegetables', 'Bakery']) {
      expect(names).not.toContain(category);
    }
    expect(names.some((n) => n.startsWith('Product'))).toBe(false);
  });

  it('excludes payment-summary rows (fees, bags, credits, discounts, delivery fee)', () => {
    const result = parseColes(text);
    const names = result.lines.map((l) => l.raw_name.toLowerCase());
    for (const bad of ['fees', 'bags x1', 'delivery/collection fee', 'credits', 'loyalty discount', 'your trolley']) {
      expect(names.some((n) => n.includes(bad))).toBe(false);
    }
    expect(result.lines.some((l) => l.line_total === 319.66)).toBe(false);
  });
});
