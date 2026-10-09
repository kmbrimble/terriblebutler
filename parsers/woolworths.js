// Deterministic parser for Woolworths "Supplied" invoice PDFs (text already extracted via
// pdf-parse). No LLM involved — see CLAUDE.md / the invoice-import feature plan for why.
const { parseAuDate, parseMoney, parseQuantity } = require('./shared');

// A resolved product row's tab-separated tail is always [description, ordered, supplied,
// price, amount] once any line-number prefix has been stripped and any wrapped description
// continuation has been joined back on. Rows are handled as token lists (the tab-separated
// fields, trimmed, empties dropped) so a wrapped description can be extended one line at a time
// without re-splitting everything buffered so far (that was quadratic in the number of wrapped
// lines). Returns null if the tokens don't (yet) resolve to a complete row — the caller keeps
// buffering lines until they do.
const tokenise = (str) => str.split('\t').map((s) => s.trim()).filter((s) => s.length);

function resolveTokens(parts) {
  if (parts.length < 5) return null;
  const [priceTok, amountTok] = parts.slice(-2);
  const orderedTok = parts[parts.length - 4];
  const suppliedTok = parts[parts.length - 3];

  const price = parseMoney(priceTok);
  const amount = parseMoney(amountTok);
  const ordered = parseQuantity(orderedTok);
  const supplied = parseQuantity(suppliedTok);
  if (price === null || amount === null || ordered === null || supplied === null) return null;

  let name = parts.slice(0, parts.length - 4).join(' ');
  let gstApplicable = false;
  if (name.startsWith('*')) {
    gstApplicable = true;
    name = name.slice(1).trim();
  }
  return {
    raw_name: name,
    qty_ordered: ordered,
    qty_supplied: supplied,
    unit_price: price,
    line_total: amount,
    gst_applicable: gstApplicable,
  };
}

// A real row, wrapped or not, is a few hundred characters at most. Buffering more than this means
// the lines are not a product row at all, so the buffer is dropped rather than grown without bound.
const MAX_PENDING_CHARS = 4000;

// Appends a physical line to a buffered row. The buffered text and the line are joined with one
// space, so the buffer's last field and the line's first field (the text either side of that
// space, with no tab between) become a single field; every other tab still separates fields.
function extendPending(pending, line) {
  const [first, ...rest] = line.split('\t');
  const tokens = pending.tokens.slice(0, -1);
  tokens.push(`${pending.tokens[pending.tokens.length - 1]} ${first.trim()}`);
  for (const field of rest) {
    const trimmed = field.trim();
    if (trimmed.length) tokens.push(trimmed);
  }
  return { tokens, chars: pending.chars + 1 + line.length };
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
      pending = { tokens: tokenise(numMatch[2]), chars: numMatch[2].length };
      const resolved = resolveTokens(pending.tokens);
      if (resolved) {
        lines.push({ ...resolved, category_hint: categoryHint });
        pending = null;
      }
      continue;
    }

    // A long description wraps onto the next physical PDF line before its numeric columns.
    if (pending !== null) {
      const combined = pending.tokens.length ? extendPending(pending, line) : { tokens: tokenise(line), chars: line.length };
      const resolved = resolveTokens(combined.tokens);
      if (resolved) {
        lines.push({ ...resolved, category_hint: categoryHint });
        pending = null;
      } else {
        pending = combined.chars > MAX_PENDING_CHARS ? null : combined;
      }
      continue;
    }
    // Anything else (footer text, totals block) is neither a product row nor a continuation.
  }

  return { invoice_number: invoiceNumber, invoice_date: invoiceDate, lines };
}

module.exports = { parseWoolworths };
