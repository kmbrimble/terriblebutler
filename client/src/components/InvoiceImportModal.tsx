import { useEffect, useRef, useState } from 'react';
import {
  startInvoiceImport,
  getInvoiceImport,
  patchInvoiceImportLine,
  commitInvoiceImport,
  type InvoiceImportState,
  type InvoiceImportLine,
  type Category,
  type Location,
} from '../lib/api';
import { resolveLineCategoryValue, resolveLineLocationValue, isCommitEnabled, matchLabel, formatSummaryLine } from '../lib/invoiceImportLine';
import { showToast } from '../lib/toast';
import { BarcodeScannerModal } from './BarcodeScannerModal';

export const ACTIVE_IMPORT_KEY = 'tb_active_import_id';

// Ports openInvoiceImportModal()/processInvoiceImport()/renderInvoiceImportStaging()/
// renderInvoiceImportLine()/patchInvoiceLine()/commitInvoiceImport() from public/index.html —
// the deterministic Coles/Woolworths parser flow (see this stage's CHANGELOG entry for why
// the separate plain-LLM upload+commit flow is out of scope). Every field edit PATCHes
// immediately server-side (invoice_imports/invoice_import_lines tables), which is what makes
// review crash-safe: resuming re-fetches from localStorage's tb_active_import_id on mount,
// same key legacy uses, so either front end can resume an import the other one started.
export function InvoiceImportModal({
  categories,
  locations,
  onClose,
  onCommitted,
}: {
  categories: Category[];
  locations: Location[];
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [state, setState] = useState<InvoiceImportState | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanningLineId, setScanningLineId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const activeId = localStorage.getItem(ACTIVE_IMPORT_KEY);
    if (!activeId) return;
    getInvoiceImport(Number(activeId))
      .then((result) => {
        if (result && result.import.status !== 'committed') setState(result);
        else localStorage.removeItem(ACTIVE_IMPORT_KEY);
      })
      .catch(() => {});
  }, []);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const result = await startInvoiceImport(file);
      localStorage.setItem(ACTIVE_IMPORT_KEY, String(result.import.id));
      setState(result);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to import invoice.', 'error');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function patchLine(lineId: number, fields: Partial<InvoiceImportLine>) {
    if (!state) return;
    const updated = await patchInvoiceImportLine(state.import.id, lineId, fields).catch(() => null);
    if (!updated) return;
    setState({ ...state, lines: state.lines.map((l) => (l.id === lineId ? updated : l)) });
  }

  async function handleScan(barcode: string) {
    const lineId = scanningLineId;
    setScanningLineId(null);
    if (lineId == null) return;
    await patchLine(lineId, { barcode_scanned: barcode });
  }

  async function handleCommit() {
    if (!state) return;
    try {
      const summary = await commitInvoiceImport(state.import.id);
      showToast(`Imported: ${summary.items_added} new, ${summary.items_matched} merged, $${summary.total_value.toFixed(2)} total`);
      localStorage.removeItem(ACTIVE_IMPORT_KEY);
      setState(null);
      onCommitted();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to commit the invoice import.', 'error');
    }
  }

  return (
    <div data-testid="invoice-import-modal" className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-rimmy-orange">Import Coles/Woolworths Invoice</h2>
          <button type="button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        {!state ? (
          <div>
            <input
              type="file"
              data-testid="invoice-import-file-input"
              accept="application/pdf"
              ref={fileInputRef}
              onChange={handleFileSelected}
              className="w-full bg-rimmy-black border border-rimmy-border rounded p-2 text-rimmy-text"
            />
            {loading && <p className="text-sm text-rimmy-textMuted mt-2">Parsing invoice…</p>}
          </div>
        ) : (
          <div data-testid="invoice-import-staging-container" className="flex flex-col gap-3 overflow-hidden flex-1">
            <p data-testid="invoice-import-summary-line" className="text-sm text-rimmy-textMuted shrink-0">
              {formatSummaryLine(state.import, state.lines.length)}
            </p>
            <div className="flex flex-col gap-3 overflow-y-auto pr-2 pb-2">
              {state.lines.map((line) => (
                <InvoiceImportLineRow
                  key={line.id}
                  line={line}
                  categories={categories}
                  locations={locations}
                  onPatch={(fields) => patchLine(line.id, fields)}
                  onScanBarcode={() => setScanningLineId(line.id)}
                />
              ))}
            </div>
            <button
              type="button"
              data-testid="invoice-import-commit-button"
              disabled={!isCommitEnabled(state.lines)}
              onClick={handleCommit}
              className="touch-target shrink-0 w-full bg-rimmy-orange hover:bg-rimmy-orangeHover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded font-bold py-3 mt-2"
            >
              Import to Inventory
            </button>
          </div>
        )}
      </div>
      {scanningLineId !== null && <BarcodeScannerModal onScan={handleScan} onClose={() => setScanningLineId(null)} />}
    </div>
  );
}

function InvoiceImportLineRow({
  line,
  categories,
  locations,
  onPatch,
  onScanBarcode,
}: {
  line: InvoiceImportLine;
  categories: Category[];
  locations: Location[];
  onPatch: (fields: Partial<InvoiceImportLine>) => void;
  onScanBarcode: () => void;
}) {
  const statusBadge =
    line.line_status === 'skipped' ? (
      <span className="text-xs font-bold text-gray-500 shrink-0">SKIPPED</span>
    ) : line.line_status === 'reviewed' ? (
      <span className="text-xs font-bold text-emerald-400 shrink-0">REVIEWED</span>
    ) : (
      <span className="text-xs font-bold text-amber-400 shrink-0">PENDING</span>
    );

  return (
    <div
      data-testid="invoice-import-line"
      data-line-id={line.id}
      className={`border border-rimmy-border rounded-lg p-3 bg-rimmy-black flex flex-col gap-2 ${line.line_status === 'skipped' ? 'opacity-50' : ''}`}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <p className="font-bold text-[15px] leading-tight break-words text-rimmy-text">{line.raw_name}</p>
          <p className="text-xs text-rimmy-textMuted mt-1">
            Qty supplied: {line.qty_supplied ?? '-'} | ${Number(line.unit_price ?? 0).toFixed(2)} ea | {line.gst_applicable ? 'GST' : 'No GST'}
          </p>
          <p className={`text-xs mt-1 ${line.matched_item_id ? 'text-emerald-400' : 'text-rimmy-textMuted'}`}>{matchLabel(line)}</p>
        </div>
        {statusBadge}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          data-testid="invoice-import-line-category-select"
          value={resolveLineCategoryValue(line)}
          onChange={(e) => onPatch({ final_category_id: e.target.value ? Number(e.target.value) : null })}
          className="flex-1 border border-rimmy-border rounded p-2 bg-rimmy-charcoal text-rimmy-text text-sm"
        >
          <option value="">Select category...</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          data-testid="invoice-import-line-location-select"
          value={resolveLineLocationValue(line)}
          onChange={(e) => onPatch({ final_location_id: e.target.value ? Number(e.target.value) : null })}
          className="flex-1 border border-rimmy-border rounded p-2 bg-rimmy-charcoal text-rimmy-text text-sm"
        >
          <option value="">Select location...</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs font-bold text-rimmy-textMuted whitespace-nowrap">Qty confirmed:</label>
        <input
          type="number"
          step="0.1"
          data-testid="invoice-import-line-qty-input"
          value={line.qty_confirmed ?? line.qty_supplied ?? 0}
          onChange={(e) => onPatch({ qty_confirmed: e.target.value === '' ? null : Number(e.target.value) })}
          className="flex-1 border border-rimmy-border rounded p-2 bg-rimmy-charcoal text-rimmy-text text-sm"
        />
        <button
          type="button"
          onClick={onScanBarcode}
          className="touch-target w-10 h-10 flex items-center justify-center bg-rimmy-charcoal border border-rimmy-border hover:border-rimmy-orange text-rimmy-text rounded shrink-0"
        >
          #
        </button>
      </div>
      {line.barcode_scanned && <p className="text-xs text-rimmy-textMuted">Scanned barcode: {line.barcode_scanned}</p>}
      <div className="flex gap-3 items-center pt-1 border-t border-rimmy-border">
        <label className="flex items-center gap-2 text-xs font-bold text-rimmy-text cursor-pointer">
          <input
            type="checkbox"
            data-testid="invoice-import-line-reviewed-checkbox"
            checked={line.line_status === 'reviewed'}
            onChange={(e) => onPatch({ line_status: e.target.checked ? 'reviewed' : 'pending' })}
            className="w-5 h-5 rounded text-rimmy-orange bg-rimmy-charcoal border-gray-600"
          />
          Reviewed
        </label>
        {line.line_status === 'skipped' ? (
          <button type="button" onClick={() => onPatch({ line_status: 'pending' })} className="text-xs underline text-rimmy-textMuted hover:text-rimmy-orange ml-auto">
            Restore
          </button>
        ) : (
          <button type="button" onClick={() => onPatch({ line_status: 'skipped' })} className="text-xs underline text-rimmy-textMuted hover:text-rimmy-orange ml-auto">
            Skip this line
          </button>
        )}
      </div>
    </div>
  );
}
