// LLM output is untrusted input: validate its shape explicitly rather than trusting
// whatever JSON the model returns. Malformed/missing/wrong-typed fields are dropped or
// defaulted here rather than flowing straight into inventory data.
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Product label parse result — always returns a safe, fully-typed object even if the
// LLM's response is malformed (matches the route's existing fallback-on-error behaviour).
function validateLabelResult(data) {
  const errors = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push('response is not an object');
    data = {};
  }
  let containerDetails = '';
  if (typeof data.container_details === 'object' && data.container_details !== null) {
    containerDetails = Object.values(data.container_details).filter(Boolean).join('');
  } else {
    containerDetails = cleanString(data.container_details);
  }
  const name = cleanString(data.name);
  const categoryName = cleanString(data.category_name);
  const locationName = cleanString(data.location_name);
  // container_details is legitimately optional (not every label states a size) so it's
  // exempt — but a genuinely empty name/category/location means the model ignored the
  // requested schema (e.g. returned unrelated hallucinated keys), not that it found
  // nothing. That must be flagged, not silently accepted as "no match".
  if (!name) errors.push('schema mismatch: missing or empty "name"');
  if (!categoryName) errors.push('schema mismatch: missing or empty "category_name"');
  if (!locationName) errors.push('schema mismatch: missing or empty "location_name"');
  return {
    name,
    container_details: containerDetails,
    category_name: categoryName,
    location_name: locationName,
    errors,
  };
}

// Invoice line items — drops any item missing a name or a valid quantity rather than
// passing malformed data through to the DB. Returns { items, errors } so the caller can
// log what was dropped and why.
function validateInvoiceItems(data) {
  const rawItems = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const items = [];
  const errors = [];
  rawItems.forEach((raw, idx) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`item ${idx}: not an object`);
      return;
    }
    const name = cleanString(raw.name);
    if (!name) {
      errors.push(`item ${idx}: missing or invalid name`);
      return;
    }
    if (!isFiniteNumber(raw.quantity) || raw.quantity < 0) {
      errors.push(`item ${idx} (${name}): missing or invalid quantity`);
      return;
    }
    items.push({
      name,
      container_details: cleanString(raw.container_details),
      quantity: raw.quantity,
      price: isFiniteNumber(raw.price) && raw.price >= 0 ? raw.price : 0,
      vendor: cleanString(raw.vendor),
      barcode: cleanString(raw.barcode) || null,
    });
  });
  return { items, errors };
}

module.exports = { validateLabelResult, validateInvoiceItems };
