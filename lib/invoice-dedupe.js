const crypto = require('crypto');

// Identity of an invoice for duplicate detection (#44). Keyed on retailer + invoice number
// when one was parsed; otherwise on a hash of the extracted text, so the same PDF uploaded
// twice is still caught. The key is stored in invoice_imports.dedupe_key behind a UNIQUE index.
function numberKey(retailer, invoiceNumber) {
  const number = String(invoiceNumber ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!number) return null;
  return `${String(retailer).trim().toLowerCase()}|no:${number}`;
}

function invoiceDedupeKey(retailer, invoiceNumber, text) {
  const byNumber = numberKey(retailer, invoiceNumber);
  if (byNumber) return byNumber;
  const normalised = String(text ?? '').replace(/\s+/g, ' ').trim();
  const hash = crypto.createHash('sha256').update(normalised).digest('hex');
  return `${String(retailer).trim().toLowerCase()}|sha256:${hash}`;
}

module.exports = { invoiceDedupeKey, numberKey };
