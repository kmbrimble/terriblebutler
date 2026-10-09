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

// Words that identify a product: lower-case letters/digits, at least 3 characters, not a size
// ("1.25L" splits to "25l", "500g", "400ml": a number with up to two unit letters), with a plural
// "s"/"es" dropped so "drinks" meets "drink" and "tomatoes" meets "tomato".
function nameTokens(name) {
  const tokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+[a-z]{0,2}$/.test(t))
    .map((t) => (t.length > 3 ? t.replace(/(?<=[osxz]|ch|sh)es$/, '').replace(/(?<!s)s$/, '') : t));
  return [...new Set(tokens)];
}

// Picks at most `max` of `items` to offer the LLM matcher for these invoice lines. An inventory
// that fits is offered whole (the matcher exists to bridge branded invoice text to broad item
// names, e.g. "Coles Lemonade Zero" to "Soft drink", which no text overlap can find). Beyond
// `max`, items are ranked per line by rare-word overlap (a word few items share counts more)
// and taken round-robin, best-first from every line, so each line keeps its strongest
// candidates and no one line crowds out the rest. Items sharing no word with any line are
// left out.
// ponytail: lexical overlap only, so over `max` items a purely semantic match with no shared
// word is not offered; raise INVOICE_MATCH_MAX_ITEMS or add embeddings if inventories get that big.
function selectMatchCandidates(items, lines, max) {
  if (items.length <= max) return items;
  const itemTokens = items.map((item) => new Set(nameTokens(item.name)));
  const documentFrequency = new Map();
  for (const tokens of itemTokens) for (const t of tokens) documentFrequency.set(t, (documentFrequency.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + items.length / documentFrequency.get(t));
  const rankings = lines.map((line) => {
    const lineTokens = nameTokens(line.raw_name).filter((t) => documentFrequency.has(t));
    const scored = [];
    itemTokens.forEach((tokens, index) => {
      let score = 0;
      for (const t of lineTokens) if (tokens.has(t)) score += idf(t);
      if (score > 0) scored.push({ index, score });
    });
    return scored.sort((a, b) => b.score - a.score || a.index - b.index);
  });
  const chosen = new Set();
  for (let rank = 0; chosen.size < max; rank++) {
    let any = false;
    for (const ranking of rankings) {
      if (rank >= ranking.length) continue;
      any = true;
      chosen.add(ranking[rank].index);
      if (chosen.size >= max) break;
    }
    if (!any) break;
  }
  return [...chosen].sort((a, b) => a - b).map((index) => items[index]);
}

module.exports = { normaliseName, findMatch, resolveNamedMatch, nameTokens, selectMatchCandidates };
