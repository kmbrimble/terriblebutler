// Worker-thread entry for PDF text extraction (see lib/uploads.js extractPdfText). Runs with
// resource limits and is terminated by the parent on a deadline; it holds no state worth saving.
const { parentPort, workerData } = require('worker_threads');
const { parsePdfText } = require('./pdf-text');

parsePdfText(workerData.data, workerData.maxPages, workerData.maxChars).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (err) => parentPort.postMessage({ ok: false, code: err && err.code, message: String(err && err.message || err) }),
);
