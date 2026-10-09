// Deterministic parser for Coles Online invoice PDFs (text already extracted via pdf-parse).
// No LLM involved — see CLAUDE.md / the invoice-import feature plan for why.
const { parseAuDate, parseMoney, parseQuantity } = require('./shared');

function tryResolveRow(line) {
  const parts = line.split('\t').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 5) return null;
  const [nameTok, orderedTok, pickedTok, priceTok, totalTok] = parts;
  if (/out of stock/i.test(nameTok)) return null;

  const ordered = parseQuantity(orderedTok);
  const picked = parseQuantity(pickedTok);
  // Coles prices always carry the dollar sign; a bare number is some other column.
  const price = priceTok.startsWith('$') ? parseMoney(priceTok) : null;
  const total = totalTok.startsWith('$') ? parseMoney(totalTok) : null;
  if (ordered === null || picked === null || price === null || total === null) return null;
  // "Picked quantity is 0 or absent" -> out of stock, excluded even if it slipped past the
  // two-line Out of Stock shape below for some reason.
  if (!picked) return null;

  let name = nameTok.replace(/''/g, "'");
  let gstApplicable = false;
  if (name.startsWith('%')) {
    gstApplicable = true;
    name = name.slice(1).trim();
  }
  return {
    raw_name: name,
    qty_ordered: ordered,
    qty_supplied: picked,
    unit_price: price,
    line_total: total,
    gst_applicable: gstApplicable,
  };
}

function parseColes(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const out = [];
  let categoryHint = null;
  let stopped = false;
  let invoiceNumber = null;
  let invoiceDate = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (!invoiceNumber) {
      const m = line.match(/Invoice number:\s*#(\S+)/);
      if (m) invoiceNumber = m[1];
    }
    if (!invoiceDate) {
      const m = line.match(/Invoice date:\s*([^\t]+)/);
      if (m) invoiceDate = parseAuDate(m[1].trim());
    }

    // "Payment summary" (fees, bags, credits, discounts, delivery fee, totals) follows the
    // product tables and shares a similar label/amount shape — terminate on the marker
    // rather than blocklisting each label.
    if (!stopped && (/^Payment summary/.test(line) || line.startsWith('Your trolley ('))) {
      stopped = true;
    }
    if (stopped) continue;

    if (/^Product\b/.test(line)) continue; // repeated column-header row

    // A category header ("Pantry", "Health & Beauty", ...) is always immediately followed
    // by the column-header row.
    if (lines[i + 1] && /^Product\b/.test(lines[i + 1])) {
      categoryHint = line;
      continue;
    }

    const resolved = tryResolveRow(line);
    if (resolved) out.push({ ...resolved, category_hint: categoryHint });
  }

  return { invoice_number: invoiceNumber, invoice_date: invoiceDate, lines: out };
}

module.exports = { parseColes };
