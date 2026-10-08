import type { InvoiceImport, InvoiceImportLine, Item } from './api';

// Ports the pure decision logic out of renderInvoiceImportLine()/renderInvoiceImportStaging()/
// updateInvoiceImportCommitState() in public/index.html, so it's testable without a DOM.

// A cleared category/location is a deliberate "none" (#46) and must not revert to the suggestion;
// only a line the reviewer never touched falls back to it. The server applies the same rule at commit.
export function resolveLineCategoryValue(line: InvoiceImportLine): number | '' {
  if (line.category_cleared) return '';
  return line.final_category_id ?? line.suggested_category_id ?? '';
}

export function resolveLineLocationValue(line: InvoiceImportLine): number | '' {
  if (line.location_cleared) return '';
  return line.final_location_id ?? line.suggested_location_id ?? '';
}

// The quantity a line will be committed with: the reviewer's confirmed figure, else what the
// invoice supplied. null means neither exists, and the server refuses to commit such a line
// unless it is skipped — it is never silently read as 0.
export function resolveLineQuantity(line: InvoiceImportLine): number | null {
  return line.qty_confirmed ?? line.qty_supplied ?? null;
}

export function lineNeedsQuantity(line: InvoiceImportLine): boolean {
  return line.line_status !== 'skipped' && resolveLineQuantity(line) === null;
}

// An import with no lines has nothing to commit (#47), and a line being imported needs a
// quantity; the server refuses both too.
export function isCommitEnabled(lines: InvoiceImportLine[]): boolean {
  return lines.length > 0 && !lines.some((l) => l.line_status === 'pending' || lineNeedsQuantity(l));
}

export function matchLabel(line: InvoiceImportLine): string {
  return line.matched_item_id ? 'Will merge into an existing item' : 'Will be added as a new item';
}

// fixes #40: the review screen edits final_name/final_container_details rather than raw_name
// itself, so raw_name stays an untouched record of what the invoice actually said.
export function resolveLineNameValue(line: InvoiceImportLine): string {
  return line.final_name ?? line.raw_name;
}

export function resolveLineContainerValue(line: InvoiceImportLine): string {
  return line.final_container_details ?? '';
}

// The "merge into existing item" field is dual-purpose: typing an existing item's name merges
// into it; typing anything else non-empty is taken as the preferred name for a NEW item — no
// more falling back to the raw (often branded, verbose) invoice description. Returns the patch
// to apply, or null when the typed text already matches the line's current state (avoids a
// redundant PATCH on every keystroke once nothing would actually change).
export function resolveMatchFieldPatch(
  typedValue: string,
  items: Pick<Item, 'id' | 'name'>[],
  current: Pick<InvoiceImportLine, 'matched_item_id' | 'final_name'>
): { matched_item_id: number | null; final_name: string | null } | null {
  const trimmed = typedValue.trim();
  if (trimmed === '') {
    if (current.matched_item_id === null && current.final_name === null) return null;
    return { matched_item_id: null, final_name: null };
  }
  const exact = items.find((i) => i.name.toLowerCase() === trimmed.toLowerCase());
  if (exact) {
    if (exact.id === current.matched_item_id && current.final_name === null) return null;
    return { matched_item_id: exact.id, final_name: null };
  }
  if (current.matched_item_id === null && current.final_name === trimmed) return null;
  return { matched_item_id: null, final_name: trimmed };
}

export function formatSummaryLine(imp: InvoiceImport, lineCount: number): string {
  const retailerLabel = imp.retailer ? imp.retailer[0].toUpperCase() + imp.retailer.slice(1) : 'Unknown retailer';
  return `${retailerLabel} — invoice ${imp.invoice_number || '?'} (${imp.invoice_date || 'unknown date'}) — ${lineCount} line${lineCount === 1 ? '' : 's'}`;
}

// Optimistic local view of a PATCH, so controlled inputs follow the user immediately. Clearing a
// category/location also sets its cleared flag, as the server will.
export function applyLinePatch(line: InvoiceImportLine, fields: Partial<InvoiceImportLine>): InvoiceImportLine {
  const next = { ...line, ...fields };
  if ('final_category_id' in fields) next.category_cleared = fields.final_category_id == null ? 1 : 0;
  if ('final_location_id' in fields) next.location_cleared = fields.final_location_id == null ? 1 : 0;
  return next;
}
