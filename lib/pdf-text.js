// Page-bounded PDF text extraction. Pure and synchronous in spirit; lib/uploads.js runs it inside
// a worker thread (lib/pdf-worker.js) so a hostile document can be killed on a deadline.
const { PDFParse } = require('pdf-parse');

// Reads at most maxPages + 1 pages, enough to know whether the limit is exceeded, without
// processing the rest of a long document. `total` is the document's real page count.
class TextTooLargeError extends Error {
  constructor(limit) {
    super(`The PDF's text is longer than ${limit} characters.`);
    this.code = 'PDF_TEXT_TOO_LARGE';
  }
}

// `maxChars` bounds the extracted text: it is checked here, in the worker, so an oversized result is
// refused before it is copied to the main thread.
async function parsePdfText(data, maxPages, maxChars = Infinity) {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ first: maxPages + 1 });
    if (result.text.length > maxChars) throw new TextTooLargeError(maxChars);
    return { total: result.total, text: result.text };
  } finally {
    await parser.destroy().catch((err) => console.error('[Uploads] PDF parser cleanup failed:', err.message));
  }
}

module.exports = { parsePdfText, TextTooLargeError };
