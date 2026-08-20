import { useEffect, useState } from 'react';
import { getItemDetails, getPriceHistory, deletePriceHistoryEntry } from '../lib/api';
import type { Item, ItemDetails, PriceHistoryEntry, PurchaseSummary } from '../lib/api';
import { chartPoints, priceExtremes } from '../lib/priceHistoryChart';
import { showToast } from '../lib/toast';

// Renamed from PriceHistoryModal (stage 5) to ItemDetailModal (stage 6): the whole card is now
// the trigger (tap-anywhere, see ItemCard's pointer handling), and this view combines stage 5's
// price history with the rest of legacy's details modal (openDetailsModal(), public/index.html
// ~L2117-2156) — category, container, barcode, and stock-by-location breakdown — in one place
// rather than two separate views. The Chart.js line chart stays ported to a small inline SVG
// (see lib/priceHistoryChart.ts), unchanged from stage 5.
const CHART_WIDTH = 300;
const CHART_HEIGHT = 140;
const CHART_PADDING = 20;

function formatPurchase(p: PurchaseSummary | null): string {
  if (!p || !(p.price > 0)) return 'N/A';
  return `$${p.price.toFixed(2)} at ${p.vendor} on ${new Date(p.recorded_at).toLocaleDateString()}`;
}

export function ItemDetailModal({ item, onClose }: { item: Item; onClose: () => void }) {
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [history, setHistory] = useState<PriceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [d, h] = await Promise.all([getItemDetails(item.id), getPriceHistory(item.id)]);
      setDetails(d);
      setHistory(h);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load item details.', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  async function handleDelete(entryId: number) {
    if (!window.confirm('Delete this price history record?')) return;
    try {
      await deletePriceHistoryEntry(entryId);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete the price history entry.', 'error');
    }
  }

  const points = chartPoints(history);
  const { max, min } = priceExtremes(history);
  const maxPrice = Math.max(...points.map((p) => p.price), 0) || 1;

  return (
    <div data-testid="details-modal" className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 data-testid="details-title" className="text-xl font-bold text-rimmy-orange">
            {item.name}
          </h2>
          <button type="button" data-testid="modal-close-button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        {!loading && details && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4 bg-rimmy-black p-4 rounded border border-rimmy-border text-sm">
              <div>
                <p className="text-xs text-rimmy-textMuted uppercase font-bold">Category</p>
                <p data-testid="details-category" className="text-rimmy-text">
                  {details.category_name || '-'}
                </p>
              </div>
              <div>
                <p className="text-xs text-rimmy-textMuted uppercase font-bold">Total Stock</p>
                <p data-testid="details-total-stock" className="text-rimmy-text">
                  {details.quantity} across {details.locations.length} location{details.locations.length === 1 ? '' : 's'}
                </p>
              </div>
              <div>
                <p className="text-xs text-rimmy-textMuted uppercase font-bold">Details</p>
                <p data-testid="details-container" className="text-rimmy-text">
                  {details.container_details || '-'}
                </p>
              </div>
              <div>
                <p className="text-xs text-rimmy-textMuted uppercase font-bold">Barcode</p>
                <p data-testid="details-barcode" className="text-rimmy-text">
                  {details.barcode || '-'}
                </p>
              </div>
            </div>

            <h3 className="font-bold text-sm text-rimmy-orange mb-2 uppercase">Stock by Location</h3>
            <ul data-testid="details-locations-breakdown" className="mb-6 text-sm">
              {details.locations.length === 0 ? (
                <li className="text-rimmy-textMuted">No stock recorded.</li>
              ) : (
                details.locations.map((l) => (
                  <li
                    key={l.location_id ?? 'unassigned'}
                    data-testid="details-locations-row"
                    className="flex justify-between border-b border-rimmy-border pb-1 mb-1 text-rimmy-text"
                  >
                    <span>{l.location_name || 'Unassigned'}</span>
                    <span className="font-bold">{l.quantity}</span>
                  </li>
                ))
              )}
            </ul>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 bg-rimmy-black p-4 rounded border border-rimmy-border">
              <div>
                <p className="text-xs text-rimmy-textMuted uppercase font-bold">Last Purchase</p>
                <p data-testid="details-last-purchase" className="text-rimmy-text">
                  {formatPurchase(details.last_purchase)}
                </p>
              </div>
              <div>
                <p className="text-xs text-rimmy-textMuted uppercase font-bold">Lowest Purchase</p>
                <p data-testid="details-lowest-purchase" className="text-rimmy-text">
                  {formatPurchase(details.lowest_purchase)}
                </p>
              </div>
            </div>

            <h3 className="font-bold text-lg text-rimmy-orange mb-2">Price Trend</h3>
            <div className="w-full overflow-x-auto mb-6 border border-rimmy-border rounded bg-rimmy-black p-2">
              {points.length === 0 ? (
                <p className="text-center py-8 text-rimmy-textMuted">No price data to chart yet.</p>
              ) : (
                <svg
                  data-testid="price-chart"
                  viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                  className="w-full"
                  style={{ minWidth: 300, height: 140 }}
                >
                  {(() => {
                    const innerW = CHART_WIDTH - 2 * CHART_PADDING;
                    const innerH = CHART_HEIGHT - 2 * CHART_PADDING;
                    const coords = points.map((p, i) => ({
                      x: CHART_PADDING + (points.length > 1 ? (i * innerW) / (points.length - 1) : innerW / 2),
                      y: CHART_HEIGHT - CHART_PADDING - (p.price / maxPrice) * innerH,
                    }));
                    const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
                    const areaPath = `${linePath} L${coords[coords.length - 1].x},${CHART_HEIGHT - CHART_PADDING} L${coords[0].x},${CHART_HEIGHT - CHART_PADDING} Z`;
                    return (
                      <>
                        {coords.length > 1 && <path d={areaPath} fill="rgba(255, 111, 0, 0.1)" stroke="none" />}
                        {coords.length > 1 && <path d={linePath} fill="none" stroke="#FF6F00" strokeWidth={2} />}
                        {coords.map((c, i) => (
                          <circle key={i} cx={c.x} cy={c.y} r={4} fill="#6A0DAD" stroke="#fff" strokeWidth={1} />
                        ))}
                      </>
                    );
                  })()}
                </svg>
              )}
            </div>

            <h3 className="font-bold text-lg text-rimmy-orange mb-2">History</h3>
            <div className="overflow-x-auto border border-rimmy-border rounded bg-rimmy-black">
              <table className="w-full text-left text-sm text-rimmy-text">
                <thead className="bg-rimmy-charcoal text-xs uppercase text-rimmy-textMuted">
                  <tr>
                    <th className="px-4 py-2 border-b border-rimmy-border">Date</th>
                    <th className="px-4 py-2 border-b border-rimmy-border">Price</th>
                    <th className="px-4 py-2 border-b border-rimmy-border">Vendor</th>
                    <th className="px-4 py-2 border-b border-rimmy-border w-10"></th>
                  </tr>
                </thead>
                <tbody data-testid="price-history-table-body">
                  {history.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center py-4 text-rimmy-textMuted">
                        No history available
                      </td>
                    </tr>
                  ) : (
                    history.map((h) => {
                      let colorClass = 'text-rimmy-text';
                      if (h.price !== null && h.price > 0) {
                        if (h.price === max) colorClass = 'text-red-500 font-bold';
                        else if (h.price === min && min !== max) colorClass = 'text-green-500 font-bold';
                      }
                      return (
                        <tr key={h.id} data-testid="price-history-row" className="border-b border-rimmy-border hover:bg-rimmy-charcoal transition-colors">
                          <td className="px-4 py-3">{new Date(h.recorded_at).toLocaleDateString()}</td>
                          <td className={`px-4 py-3 ${colorClass}`}>{h.price !== null && h.price > 0 ? `$${h.price.toFixed(2)}` : '-'}</td>
                          <td className="px-4 py-3 truncate max-w-[120px]">{h.vendor || ''}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              data-testid="price-history-delete-button"
                              onClick={() => handleDelete(h.id)}
                              className="text-red-500 hover:text-red-700 font-bold text-lg leading-none touch-target"
                            >
                              &times;
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex pt-6">
          <button type="button" onClick={onClose} className="touch-target flex-1 bg-gray-600 text-white rounded font-bold">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
