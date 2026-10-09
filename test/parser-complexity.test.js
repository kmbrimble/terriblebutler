// The Woolworths parser used to rebuild and re-split the whole buffered description for every
// wrapped line (quadratic: 20,000 wrapped lines took ~19 s on the main thread). It is now linear.
// A copy of the pre-rewrite implementation (with the current strict number rules) is the oracle for "output identical".
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { PDFParse } from 'pdf-parse';
import './setup.js';
import { finiteNumber } from '../lib/domain-helpers.js';

const require = createRequire(import.meta.url);
const { parseWoolworths } = require('../parsers/woolworths.js');
const { parseColes } = require('../parsers/coles.js');
const { parseAuDate } = require('../parsers/shared.js');
const { parseInvoice } = require('../parsers/router.js');
const reference = require('./helpers/woolworths-reference.cjs').parseWoolworths;

async function fixtureText(name) {
  const parser = new PDFParse({ data: fs.readFileSync(path.join(process.cwd(), 'test/fixtures/invoices', name)) });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

describe('Woolworths parser output matches the oracle', () => {
  let text;
  beforeAll(async () => { text = await fixtureText('woolworths-example.pdf'); });

  it('matches the oracle on the real fixture (32 lines)', () => {
    const now = parseWoolworths(text);
    expect(now.lines).toHaveLength(32);
    expect(now).toEqual(reference(text));
  });

  it('matches the oracle on 6,000 random documents of wrapped, broken, malformed-number, header and junk lines', () => {
    let seed = 20261009;
    const rand = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const words = ['Cadbury', 'baking', 'chips', '360g', 'Coles', 'milk', '1.25L', '*Bread', 'x\ty', ''];
    const pick = (list) => list[rand(list.length)];
    let parsedRows = 0;
    let malformedPieces = 0;
    const badNumbers = ['1..2', '1,000', '2.', '.', '$.', '$3..00', '$1,5', '2abc', '1e3', '--1', '', 'x', '0.5 kg', '3ea'];
    const num = () => (rand(4) === 0 ? (malformedPieces += 1, pick(badNumbers)) : String(rand(5)));
    const money = () => (rand(4) === 0 ? (malformedPieces += 1, pick(badNumbers)) : `$${rand(30)}.${rand(99)}`);
    const piece = () => {
      switch (rand(11)) {
        case 9: return `${1 + rand(40)}\t${pick(words)}\t${num()}\t${num()}\t${money()}\t${money()}`;
        case 10: return `${pick(words)} ${pick(words)}\t${num()}\t${num()}\t${money()}\t${money()}`;
        case 0: return `${1 + rand(40)}\t${pick(words)} ${pick(words)}\t${rand(5)}\t${rand(5)}\t$${rand(30)}.${rand(99)}\t$${rand(90)}.00`;
        case 1: return `${1 + rand(40)} ${pick(words)} ${pick(words)}`;
        case 2: return `${pick(words)} ${pick(words)}\t${rand(5)}\t${rand(5)}\t$${rand(30)}.50\t$${rand(90)}.00`;
        case 3: return `${pick(words)}\t${pick(words)}`;
        case 4: return `${rand(9)}\t${rand(9)}\t$${rand(9)}.10`;
        case 5: return 'Line\tDescription\tOrdered\tSupplied\tPrice\tAmount';
        case 6: { const label = pick(['Baking', 'Dairy', 'Total:', 'Supplied']); return `${label}\t${label}`; }
        case 7: return `  ${pick(words)}  \t  ${pick(words)}  `;
        default: return pick(['Invoice/Order Number: 99', 'Date: 17 Jul 2026\tx', '', '   ', 'footer text']);
      }
    };
    for (let doc = 0; doc < 6000; doc++) {
      const body = Array.from({ length: 1 + rand(25) }, piece).join('\n');
      const result = parseWoolworths(body);
      expect(result, body).toEqual(reference(body));
      parsedRows += result.lines.length;
    }
    // not vacuous: plenty of rows were read, and plenty of malformed numbers were thrown at both parsers
    expect(parsedRows).toBeGreaterThan(2000);
    expect(malformedPieces).toBeGreaterThan(2000);
  });
});

describe('Woolworths parser is linear in the number of wrapped lines', () => {
  const wrapped = (n, tail = '\tx') => `Invoice/Order Number: 1\n1 Thing\twrapped start\n${Array.from({ length: n }, (_, i) => `word${i} more${tail}`).join('\n')}\n`;

  it('20,000 wrapped lines parse in well under a second (the old code needed ~19 s)', () => {
    const started = Date.now();
    parseWoolworths(wrapped(20000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('the cost per line does not grow with the size of the input (8x the lines is not ~64x the time)', () => {
    const time = (n) => { const started = process.hrtime.bigint(); parseWoolworths(wrapped(n)); return Number(process.hrtime.bigint() - started) / 1e6; };
    time(2000); // warm up
    const small = Math.max(time(5000), 1);
    const large = time(40000);
    expect(large / small).toBeLessThan(40); // linear is ~8; quadratic is ~64
  });

  it('a row that completes after many wrapped lines is still read correctly', () => {
    const lines = ['1 Long description'];
    for (let i = 0; i < 30; i++) lines.push(`part${i}`);
    lines.push('last\t2\t2\t$3.00\t$6.00');
    const [row] = parseWoolworths(lines.join('\n')).lines;
    expect(row.raw_name.startsWith('Long description part0 part1')).toBe(true);
    expect(row).toMatchObject({ qty_ordered: 2, qty_supplied: 2, unit_price: 3, line_total: 6 });
  });

  it('a runaway buffer (not a product row at all) is dropped instead of growing without bound', () => {
    const result = parseWoolworths(`${wrapped(5000)}2 Real item\t1\t1\t$2.00\t$2.00\n`);
    expect(result.lines.map((l) => l.raw_name)).toEqual(['Real item']);
  });
});

describe('the other parsers and shared regexes stay linear on hostile input', () => {
  const quick = (fn, limitMs = 500) => { const started = Date.now(); fn(); expect(Date.now() - started).toBeLessThan(limitMs); };
  const big = 1_000_000;

  it('Coles: a very long document and very long lines', () => {
    const rows = Array.from({ length: 30000 }, (_, i) => `Item ${i}\t1\t1\t$1.00\t$1.00`).join('\n');
    quick(() => parseColes(`Invoice number: #1\nPantry\nProduct\tOrdered\tPicked\tPrice\tTotal\n${rows}`));
    quick(() => parseColes(`Invoice number: #${'9'.repeat(big)}x\n${'a\t'.repeat(big / 2)}`));
  });

  it('Woolworths: one enormous line of digits, tabs or label text', () => {
    quick(() => parseWoolworths(`${'1'.repeat(big)}x`));
    quick(() => parseWoolworths(`1 ${'a\t'.repeat(big / 2)}`));
    quick(() => parseWoolworths(`Invoice/Order Number: ${'x'.repeat(big)}\nDate: ${'7'.repeat(big)}`));
  });

  it('parseAuDate and the router on long input', () => {
    quick(() => parseAuDate(`${'1'.repeat(big)} Jan 2026`));
    quick(() => parseAuDate(`17 ${'A'.repeat(big)} 2026`));
    quick(() => parseInvoice('x'.repeat(big)));
  });
});

describe('finiteNumber has no polynomial regex on long input', () => {
  it.each(['1'.repeat(30000), `${'1'.repeat(30000)}x`, `${'1'.repeat(30000)}.${'1'.repeat(30000)}x`, '.'.repeat(30000), `${' '.repeat(100000)}7`])('rejects a long string quickly (%#)', (text) => {
    const started = Date.now();
    expect(() => finiteNumber(text, { name: 'Amount' })).toThrow();
    expect(Date.now() - started).toBeLessThan(100);
  });
});
