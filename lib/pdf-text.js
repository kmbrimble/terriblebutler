// Page-bounded PDF text extraction. Pure and synchronous in spirit; lib/uploads.js runs it inside
// a worker thread (lib/pdf-worker.js) so a hostile document can be killed on a deadline.
const { PDFParse } = require('pdf-parse');

// Reads at most maxPages + 1 pages, enough to know whether the limit is exceeded, without
// processing the rest of a long document. `total` is the document's real page count.
async function parsePdfText(data, maxPages) {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ first: maxPages + 1 });
    return { total: result.total, text: result.text };
  } finally {
    await parser.destroy().catch((err) => console.error('[Uploads] PDF parser cleanup failed:', err.message));
  }
}

module.exports = { parsePdfText };
