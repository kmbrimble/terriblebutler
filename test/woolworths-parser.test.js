import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import { parseWoolworths } from '../parsers/woolworths.js';

let text;

beforeAll(async () => {
  const buf = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf'));
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  text = result.text;
  await parser.destroy();
});

describe('parseWoolworths', () => {
  it('extracts invoice_number and invoice_date', () => {
    const result = parseWoolworths(text);
    expect(result.invoice_number).toBe('310473367');
    expect(result.invoice_date).toBe('2026-07-17');
  });

  it('parses the exact expected line count across both pages', () => {
    const result = parseWoolworths(text);
    expect(result.lines).toHaveLength(32);
  });

  it('spot-checks a non-GST line', () => {
    const result = parseWoolworths(text);
    const line = result.lines.find((l) => l.raw_name === 'Cadbury baking chips milk chocolate 360g');
    expect(line).toMatchObject({
      qty_ordered: 2,
      qty_supplied: 2,
      unit_price: 8.4,
      line_total: 16.8,
      gst_applicable: false,
    });
  });

  it('spot-checks a GST-applicable line and strips the "*" prefix', () => {
    const result = parseWoolworths(text);
    const line = result.lines.find((l) => l.raw_name === 'Milkybar white choc block 170g');
    expect(line).toMatchObject({
      qty_ordered: 2,
      qty_supplied: 2,
      unit_price: 3.75,
      line_total: 7.5,
      gst_applicable: true,
    });
  });

  it('reassembles a GST-applicable description that wraps across two physical PDF lines', () => {
    const result = parseWoolworths(text);
    const line = result.lines.find((l) =>
      l.raw_name === 'Nestle golden rough milk chocolate with roasted coconut block 170g'
    );
    expect(line).toMatchObject({
      qty_ordered: 4,
      qty_supplied: 4,
      unit_price: 3.75,
      line_total: 15,
      gst_applicable: true,
    });
  });

  it('parses a weighted item whose Supplied quantity carries a "kg" suffix', () => {
    const result = parseWoolworths(text);
    const line = result.lines.find((l) =>
      l.raw_name === 'Woolworths rspca approved chicken breast fillet per 350g'
    );
    expect(line).toMatchObject({
      qty_ordered: 8.05,
      qty_supplied: 8.05,
      unit_price: 8.9,
      line_total: 71.65,
      gst_applicable: false,
    });
  });

  it('parses lines spanning the page 2 continuation of the Supplied table', () => {
    const result = parseWoolworths(text);
    const line = result.lines.find((l) => l.raw_name === 'Woolworths frozen basa fillets 1kg');
    expect(line).toMatchObject({
      qty_ordered: 6,
      qty_supplied: 6,
      unit_price: 7.2,
      line_total: 43.2,
      gst_applicable: false,
    });
  });

  it('excludes category header rows from lines', () => {
    const result = parseWoolworths(text);
    const names = result.lines.map((l) => l.raw_name);
    for (const category of ['Baking', 'Confectionery', 'Dairy', 'Frozen Food', 'Health & Wellbeing']) {
      expect(names).not.toContain(category);
    }
  });

  it('stops at the totals block and does not leak Sub Total / Invoice Total rows', () => {
    const result = parseWoolworths(text);
    const names = result.lines.map((l) => l.raw_name.toLowerCase());
    for (const bad of ['sub total', 'invoice total', 'promotional discount', 'delivery fee', 'service fees']) {
      expect(names.some((n) => n.includes(bad))).toBe(false);
    }
    // The bare totals figures ($432.15 etc, printed on their own line with no line number)
    // must not be picked up as product rows either.
    expect(result.lines.some((l) => l.line_total === 432.15)).toBe(false);
  });
});
