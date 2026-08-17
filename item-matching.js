// Shared duplicate-detection hierarchy for invoice commits and manual item adds.
// Order: barcode match > exact normalised-name match > fuzzy (suggestion only, never auto-applied).
function normaliseName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// existingItems: array of {id, name, barcode, ...}. fuse: a Fuse instance built on the
// same array (kept in sync by the caller as items are inserted), or null to skip fuzzy.
// Returns { type: 'barcode'|'exact_name'|'fuzzy'|null, item, candidates }.
// `item` is only set for barcode/exact_name — the single confident, safe-to-auto-apply match.
// Fuzzy always returns `item: null`; a fuzzy candidate must be confirmed by the user first.
function findMatch(existingItems, { barcode, name }, fuse) {
  if (barcode) {
    const barcodeMatch = existingItems.find((i) => i.barcode && i.barcode === barcode);
    if (barcodeMatch) return { type: 'barcode', item: barcodeMatch, candidates: [barcodeMatch] };
  }
  const normalised = normaliseName(name);
  if (normalised) {
    const exactMatches = existingItems.filter((i) => normaliseName(i.name) === normalised);
    if (exactMatches.length > 0) return { type: 'exact_name', item: exactMatches[0], candidates: exactMatches };
  }
  const fuzzyHits = fuse && name ? fuse.search(name).map((r) => r.item) : [];
  if (fuzzyHits.length > 0) return { type: 'fuzzy', item: null, candidates: fuzzyHits };
  return { type: null, item: null, candidates: [] };
}

// Resolves an LLM-suggested category/location name against an existing {id, name} list.
// Mirrors findMatch's hierarchy but for a single flat name rather than a full item: exact
// case-insensitive match wins outright; otherwise the raw suggested name and the closest
// fuzzy candidate (if any) are returned for the caller to offer the user a create/pick/
// rename choice. Never auto-creates or auto-selects on a fuzzy hit.
function resolveNamedMatch(list, rawName, fuse) {
  const name = String(rawName || '').trim();
  if (!name) return { id: null, suggested_name: null, similar: null };
  const exact = list.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (exact) return { id: exact.id, suggested_name: null, similar: null };
  const fuzzyHits = fuse ? fuse.search(name) : [];
  const similar = fuzzyHits.length > 0 ? { id: fuzzyHits[0].item.id, name: fuzzyHits[0].item.name } : null;
  return { id: null, suggested_name: name, similar };
}

module.exports = { normaliseName, findMatch, resolveNamedMatch };
