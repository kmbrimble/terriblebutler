// Deterministic parser for Woolworths "Supplied" invoice PDFs (text already extracted via
// pdf-parse). No LLM involved — see CLAUDE.md / the invoice-import feature plan for why.
const { parseAuDate } = require('./shared');

// A resolved product row's tab-separated tail is always [description, ordered, supplied,
// price, amount] once any line-number prefix has been stripped and any wrapped description
// continuation has been joined back on. Returns null if `str` doesn't (yet) resolve to a
// complete row — the caller keeps buffering lines until it does.
function tryResolveRow(str) {
  const parts = str.split('\t').map((s) => s.trim()).filter((s) => s.length);
  if (parts.length < 5) return null;
  const [priceTok, amountTok] = parts.slice(-2);
  const orderedTok = parts[parts.length - 4];
  const suppliedTok = parts[parts.length - 3];
  const descTok = parts.slice(0, parts.length - 4).join(' ');

  const priceMatch = priceTok.match(/^\$?([\d.]+)$/);
  const amountMatch = amountTok.match(/^\$?([\d.]+)$/);
  const orderedMatch = orderedTok.match(/^([\d.]+)/);
  const suppliedMatch = suppliedTok.match(/^([\d.]+)/);
  if (!priceMatch || !amountMatch || !orderedMatch || !suppliedMatch) return null;

  let name = descTok;
  let gstApplicable = false;
  if (name.startsWith('*')) {
    gstApplicable = true;
    name = name.slice(1).trim();
  }
  return {
    raw_name: name,
    qty_ordered: parseFloat(orderedMatch[1]),
    qty_supplied: parseFloat(suppliedMatch[1]),
    unit_price: parseFloat(priceMatch[1]),
    line_total: parseFloat(amountMatch[1]),
    gst_applicable: gstApplicable,
  };
}

function parseWoolworths(text) {
  const rawLines = text.split('\n');
  const lines = [];
  let categoryHint = null;
  let pending = null;
  let invoiceNumber = null;
  let invoiceDate = null;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!invoiceNumber) {
      const m = line.match(/Invoice\/Order Number:\s*(\S+)/);
      if (m) invoiceNumber = m[1];
    }
    if (!invoiceDate) {
      const m = line.match(/^Date:\s*([^\t]+)/);
      if (m) invoiceDate = parseAuDate(m[1].trim());
    }

    // The "Line / Description / Ordered / Supplied / Price / Amount" table header repeats
    // on every page — not a product row, and any buffered description doesn't span it.
    if (/^Line\b/.test(line)) {
      pending = null;
      continue;
    }

    const tabParts = line.split('\t').map((s) => s.trim()).filter(Boolean);
    const isDuplicatedLabel = tabParts.length >= 2 && tabParts.every((p) => p === tabParts[0]);
    // Category header rows ("Baking", "Confectionery", ...) are rendered as the same text
    // twice, back to back. Totals/footer labels (colons, digits) are excluded so they don't
    // pollute category_hint.
    if (isDuplicatedLabel && !/\d/.test(tabParts[0]) && !tabParts[0].includes(':') && tabParts[0] !== 'Supplied') {
      categoryHint = tabParts[0].replace(/^\*\s*/, '');
      pending = null;
      continue;
    }

    const numMatch = line.match(/^(\d+)\s+(.*)$/);
    if (numMatch) {
      pending = numMatch[2];
      const resolved = tryResolveRow(pending);
      if (resolved) {
        lines.push({ ...resolved, category_hint: categoryHint });
        pending = null;
      }
      continue;
    }

    // A long description wraps onto the next physical PDF line before its numeric columns.
    if (pending !== null) {
      const combined = `${pending} ${line}`;
      const resolved = tryResolveRow(combined);
      if (resolved) {
        lines.push({ ...resolved, category_hint: categoryHint });
        pending = null;
      } else {
        pending = combined;
      }
      continue;
    }
    // Anything else (footer text, totals block) is neither a product row nor a continuation.
  }

  return { invoice_number: invoiceNumber, invoice_date: invoiceDate, lines };
}

module.exports = { parseWoolworths };
