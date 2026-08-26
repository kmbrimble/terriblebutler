import type { InvoiceImport, InvoiceImportLine } from './api';

// Ports the pure decision logic out of renderInvoiceImportLine()/renderInvoiceImportStaging()/
// updateInvoiceImportCommitState() in public/index.html, so it's testable without a DOM.

export function resolveLineCategoryValue(line: InvoiceImportLine): number | '' {
  return line.final_category_id ?? line.suggested_category_id ?? '';
}

export function resolveLineLocationValue(line: InvoiceImportLine): number | '' {
  return line.final_location_id ?? line.suggested_location_id ?? '';
}

export function isCommitEnabled(lines: InvoiceImportLine[]): boolean {
  return !lines.some((l) => l.line_status === 'pending');
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

export function formatSummaryLine(imp: InvoiceImport, lineCount: number): string {
  const retailerLabel = imp.retailer ? imp.retailer[0].toUpperCase() + imp.retailer.slice(1) : 'Unknown retailer';
  return `${retailerLabel} — invoice ${imp.invoice_number || '?'} (${imp.invoice_date || 'unknown date'}) — ${lineCount} line${lineCount === 1 ? '' : 's'}`;
}
