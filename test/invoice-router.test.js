import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import { detectRetailer, parseInvoice } from '../parsers/router.js';

let woolworthsText;
let colesText;

beforeAll(async () => {
  const wBuf = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf'));
  const wParser = new PDFParse({ data: wBuf });
  woolworthsText = (await wParser.getText()).text;
  await wParser.destroy();

  const cBuf = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices/coles-example.pdf'));
  const cParser = new PDFParse({ data: cBuf });
  colesText = (await cParser.getText()).text;
  await cParser.destroy();
});

describe('invoice retailer router', () => {
  it('detects Woolworths from its ABN', () => {
    expect(detectRetailer(woolworthsText)).toBe('woolworths');
  });

  it('detects Coles from its ABN', () => {
    expect(detectRetailer(colesText)).toBe('coles');
  });

  it('returns null for text containing neither ABN', () => {
    expect(detectRetailer('Some Other Store\nABN 12 345 678 901\nThank you for shopping')).toBeNull();
  });

  it('parseInvoice routes the Woolworths fixture to the Woolworths parser', () => {
    const result = parseInvoice(woolworthsText);
    expect(result.retailer).toBe('woolworths');
    expect(result.invoice_number).toBe('310473367');
    expect(result.lines).toHaveLength(32);
  });

  it('parseInvoice routes the Coles fixture to the Coles parser', () => {
    const result = parseInvoice(colesText);
    expect(result.retailer).toBe('coles');
    expect(result.invoice_number).toBe('262486548');
    expect(result.lines).toHaveLength(30);
  });

  it('parseInvoice returns a clear unknown-retailer result rather than guessing', () => {
    const result = parseInvoice('Generic Store Pty Ltd\nSome invoice text with no known ABN.');
    expect(result.retailer).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.lines).toEqual([]);
  });
});
