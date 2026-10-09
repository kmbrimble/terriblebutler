// Shared helpers for retailer invoice parsers.
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// "17 Jul 2026" (Woolworths) or "17 July 2026" (Coles) -> "2026-07-17".
function parseAuDate(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  // A real calendar date only: 31 Feb or day 00 would otherwise be stored as an invoice date.
  const day = Number(m[1]);
  const check = new Date(Date.UTC(Number(m[3]), Number(month) - 1, day));
  if (check.getUTCFullYear() !== Number(m[3]) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== day) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

// Whole-token decimals. parseFloat and loose prefix patterns turn "1..2", "1,000" or "2abc" into a
// different, valid-looking number; these refuse anything that is not plainly a decimal.
const DECIMAL = /^(\d+(?:\.\d+)?|\.\d+)$/;

// "12.50" or "$12.50" -> 12.5, else null.
function parseMoney(token) {
  const text = String(token).trim().replace(/^\$/, '');
  return DECIMAL.test(text) ? Number(text) : null;
}

// A quantity: a plain decimal, optionally followed by a unit word ("2", "1.5", "0.526 kg", "2ea").
// Digits, dots or commas straight after the number mean it was not a plain decimal after all.
function parseQuantity(token) {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(?:\s*[A-Za-z][A-Za-z.]*)?$/.exec(String(token).trim());
  return m ? Number(m[1]) : null;
}

module.exports = { parseAuDate, parseMoney, parseQuantity };
