// Detects which retailer parser to run from a unique ABN string in the extracted PDF text.
// Adding a third retailer means adding one parser file plus one ABN entry here.
const { parseWoolworths } = require('./woolworths');
const { parseColes } = require('./coles');

const RETAILERS = [
  { key: 'woolworths', abn: 'ABN 88 000 014 675', parse: parseWoolworths },
  { key: 'coles', abn: 'ABN: 45 004 189 708', parse: parseColes },
];

function detectRetailer(text) {
  const match = RETAILERS.find((r) => text.includes(r.abn));
  return match ? match.key : null;
}

// Never guesses: an unrecognised ABN returns a clear null-retailer result so the caller can
// prompt the user to pick a retailer manually rather than silently mis-parsing.
function parseInvoice(text) {
  const match = RETAILERS.find((r) => text.includes(r.abn));
  if (!match) {
    return { retailer: null, invoice_number: null, invoice_date: null, lines: [], error: 'Unknown retailer: no recognised ABN found in this PDF.' };
  }
  return { retailer: match.key, ...match.parse(text) };
}

module.exports = { detectRetailer, parseInvoice };
