// Shared helpers for retailer invoice parsers.
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// "17 Jul 2026" (Woolworths) or "17 July 2026" (Coles) -> "2026-07-17".
function parseAuDate(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

module.exports = { parseAuDate };
