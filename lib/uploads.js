// Everything about user-supplied files lives here: the private multer scratch area, image
// validation and re-encoding, the signed-URL scheme for stored images, the delivery route, and
// bounded PDF text extraction (page limit, deadline and memory ceiling, in a worker thread).
//
// Trust model: nothing a client controls (bytes, declared MIME, filename) survives into the
// served directory. Raw uploads are written to UPLOAD_TMP_DIR, decoded by sharp, and only the
// re-encoded output is stored under a server-generated name. Stored images are reachable only
// through GET /media/:name with a short-lived HMAC signature.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { Worker } = require('worker_threads');
const config = require('./config');
const { createWorkGate, GateFullError } = require('./work-gate');

const { UPLOADS_DIR, UPLOAD_TMP_DIR, MAX_IMAGE_PIXELS, MAX_PDF_PAGES, PDF_PARSE_TIMEOUT_MS, PDF_WORKER_MEMORY_MB } = config;
const PDF_WORKER_FILE = path.join(__dirname, 'pdf-worker.js');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Raw client bytes land in the scratch directory, so at startup it must be a real directory (not a
// symlink someone planted), owned by the runtime user and private (0700). Absent is created fresh;
// anything else wrong stops the process rather than quietly writing uploads somewhere shared.
function prepareScratchDir(dir, { uid = typeof process.getuid === 'function' ? process.getuid() : undefined } = {}) {
  let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700); // mkdir's mode is subject to the umask
    stat = fs.lstatSync(dir);
  }
  if (stat.isSymbolicLink()) throw new Error(`Upload scratch directory ${dir} is a symbolic link; refusing to use it.`);
  if (!stat.isDirectory()) throw new Error(`Upload scratch path ${dir} is not a directory.`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Upload scratch directory ${dir} is owned by uid ${stat.uid}, not the runtime user (${uid}).`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`Upload scratch directory ${dir} must have mode 0700 (found ${(stat.mode & 0o777).toString(8)}).`);
}
prepareScratchDir(UPLOAD_TMP_DIR);

// --- sharp hardening ---------------------------------------------------------------------
// Defence in depth: libvips ships loaders for SVG, TIFF, GIF, HEIF, PDF, OpenSlide, ImageMagick
// and more. The app only ever needs the three below, so block every loader and re-enable those.
// HEIF/HEIC is deliberately left blocked: sharp's prebuilt libvips has no HEVC decoder, so real
// iPhone HEIC files could not be read anyway, and the libheif loader is attack surface for nothing.
// Both clients convert the chosen photo to JPEG in the browser (canvas.toBlob) before uploading.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpeg', 'VipsForeignLoadPng', 'VipsForeignLoadWebp'] });

const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp']);
const UNSUPPORTED_IMAGE_MESSAGE = 'The uploaded file is not a supported image. Use JPEG, PNG or WebP (HEIC/HEIF is not supported).';
// The one stored format. WebP keeps transparency (PNG labels), compresses well, and is
// decodable by every current browser and by React Native.
const STORED_EXT = 'webp';
const STORED_MAX_EDGE = 2048;
const STORED_NAME_RE = /^[0-9a-f]{32}\.webp$/;

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Used by routes to turn a validation failure into its HTTP status; anything else is a bug.
function uploadErrorStatus(err) {
  if (err instanceof GateFullError) return 503;
  return err instanceof UploadError ? err.status : null;
}

// Answers an upload failure uploadErrorStatus recognised (with Retry-After when the server is
// merely busy). Returns false for anything else, which the caller treats as a server fault.
function sendUploadError(res, err) {
  const status = uploadErrorStatus(err);
  if (!status) return false;
  if (err instanceof GateFullError) res.setHeader('Retry-After', String(err.retryAfterSeconds));
  res.status(status).json({ error: err.message });
  return true;
}

// The one process-wide bound on expensive upload processing: PDF extraction and every sharp
// decode/re-encode run through it (see config HEAVY_WORK_CONCURRENCY / HEAVY_WORK_QUEUE).
const heavyWork = createWorkGate({ concurrency: config.HEAVY_WORK_CONCURRENCY, queue: config.HEAVY_WORK_QUEUE });

// --- multer: private scratch storage -----------------------------------------------------
// Scratch names are random with no extension, so neither the client filename nor its type can
// influence anything on disk.
const scratchStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_TMP_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});

function fileFilterFor(allowedTypes, message) {
  return (req, file, cb) => {
    if (!allowedTypes.includes(file.mimetype)) {
      // status/expose mark this as a deliberate client error for the global error handler.
      return cb(Object.assign(new Error(message || `Unsupported file type: ${file.mimetype}`), { status: 400, expose: true }));
    }
    cb(null, true);
  };
}

// Beyond the file itself, cap the multipart envelope: only the one file part is ever read, so a
// request padded with text fields or parts is refused before it reaches a handler.
const MULTIPART_LIMITS = { files: 1, fields: 5, parts: 6, fieldNameSize: 100, fieldSize: 16 * 1024 };

// The declared MIME is only an early, cheap gate; the real check is on the decoded content.
const imageUpload = multer({
  storage: scratchStorage,
  limits: { ...MULTIPART_LIMITS, fileSize: config.MAX_IMAGE_BYTES },
  fileFilter: fileFilterFor(['image/jpeg', 'image/png', 'image/webp'], UNSUPPORTED_IMAGE_MESSAGE),
});
const invoiceUpload = multer({
  storage: scratchStorage,
  limits: { ...MULTIPART_LIMITS, fileSize: config.MAX_INVOICE_BYTES },
  fileFilter: fileFilterFor(['application/pdf']),
});

// Removes a scratch file. A missing file is fine; anything else is logged, not swallowed.
async function discardUpload(file) {
  if (!file || !file.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[Uploads] Failed to remove scratch file %s:', path.basename(file.path), err.message);
  }
}

// A crash between multer writing and the handler's cleanup would leave a scratch file behind;
// drop anything stale at startup.
(async function sweepStaleScratch() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    for (const name of await fs.promises.readdir(UPLOAD_TMP_DIR)) {
      const full = path.join(UPLOAD_TMP_DIR, name);
      const stat = await fs.promises.stat(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) await discardUpload({ path: full });
    }
  } catch (err) {
    console.error('[Uploads] Failed to sweep stale scratch files:', err.message);
  }
})();

// --- image validation and storage --------------------------------------------------------

// Opens an uploaded file with sharp only if its *decoded* format is on the allow-list and it is
// within the pixel limit. Returns the sharp pipeline for the caller to finish.
async function openValidatedImage(filePath) {
  const image = sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS });
  let meta;
  try {
    meta = await image.metadata();
  } catch (err) {
    if (/pixel limit/i.test(err.message)) throw new UploadError(`The image is too large (limit ${MAX_IMAGE_PIXELS / 1e6} megapixels).`);
    throw new UploadError(UNSUPPORTED_IMAGE_MESSAGE);
  }
  if (!ALLOWED_INPUT_FORMATS.has(meta.format)) {
    throw new UploadError(UNSUPPORTED_IMAGE_MESSAGE);
  }
  return image;
}

// Decodes, auto-orients, bounds the size, re-encodes to the canonical format (dropping
// EXIF/GPS/ICC, which sharp does unless asked to keep them) and writes it under a
// server-generated name. Returns that name, which is the stable identifier kept in the DB.
async function storeUploadedImage(filePath) {
  return heavyWork.run(() => storeUploadedImageUngated(filePath));
}

async function storeUploadedImageUngated(filePath) {
  const image = await openValidatedImage(filePath);
  const name = `${crypto.randomBytes(16).toString('hex')}.${STORED_EXT}`;
  const dest = path.join(UPLOADS_DIR, name);
  try {
    await image
      .rotate()
      .resize({ width: STORED_MAX_EDGE, height: STORED_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(dest);
  } catch (err) {
    await fs.promises.rm(dest, { force: true }).catch((rmErr) => console.error('[Uploads] Failed to remove partial image:', rmErr.message));
    // A decode failure on a file that passed the header check (truncated, corrupt, over the
    // pixel limit) is the client's problem, not a server fault.
    throw new UploadError('The uploaded image could not be processed.');
  }
  return name;
}

// --- signed URLs -------------------------------------------------------------------------
// <img src> cannot send a bearer header (and neither can a React Native <Image> cache), so
// stored images are fetched with a signature in the URL instead: HMAC-SHA256 over
// "<name>.<expiry>". The key is derived from JWT_SECRET with HKDF and a fixed info label, so
// it is domain-separated from JWT signing (a signature here can never be a JWT, and vice
// versa) without adding a second secret to deploy. Rotating JWT_SECRET therefore also
// invalidates outstanding image URLs, which the client simply refetches.
const SIGNING_KEY = Buffer.from(
  crypto.hkdfSync('sha256', config.JWT_KEY, Buffer.alloc(0), 'butler/media-url/v1', 32)
);

// Expiry is quantised: every URL minted in the same hour carries the same expiry, so a
// browser can cache an image across list refetches instead of seeing a new URL each time.
// A URL is therefore valid for between 1 and 2 hours from minting.
const URL_BUCKET_MS = 60 * 60 * 1000;

function signature(name, expSeconds) {
  return crypto.createHmac('sha256', SIGNING_KEY).update(`${name}.${expSeconds}`).digest('base64url');
}

function signMediaUrl(name, now = Date.now()) {
  if (typeof name !== 'string' || !STORED_NAME_RE.test(name)) throw new Error('Not a stored image name');
  const exp = (Math.floor(now / URL_BUCKET_MS) + 2) * (URL_BUCKET_MS / 1000);
  return `/media/${name}?exp=${exp}&sig=${signature(name, exp)}`;
}

function verifyMediaSignature(name, exp, sig, now = Date.now()) {
  if (!STORED_NAME_RE.test(name) || !/^\d{1,12}$/.test(exp || '') || !/^[A-Za-z0-9_-]{43}$/.test(sig || '')) return false;
  if (Number(exp) * 1000 <= now) return false;
  const expected = Buffer.from(signature(name, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Replaces the stored identifier on an item with a freshly signed URL. Anything that is not a
// canonical stored name (a legacy "/uploads/..." value, junk) becomes null so an unsigned or
// attacker-shaped path can never reach a client. Called from parseItemLocations, which every
// item response and Socket.IO payload passes through.
function withSignedImage(item) {
  if (item && 'image_path' in item) {
    item.image_path = STORED_NAME_RE.test(item.image_path || '') ? signMediaUrl(item.image_path) : null;
  }
  return item;
}

const MEDIA_CSP = "default-src 'none'; sandbox";

function registerMediaRoute(app) {
  app.get('/media/:name', (req, res) => {
    // Every /media response, errors included, replaces the app-wide CSP with the stricter one.
    res.setHeader('Content-Security-Policy', MEDIA_CSP);
    const { name } = req.params;
    const { exp, sig } = req.query;
    if (!STORED_NAME_RE.test(name)) return res.status(404).json({ error: 'Not found' });
    if (typeof exp !== 'string' || typeof sig !== 'string' || !verifyMediaSignature(name, exp, sig)) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    // Belt and braces: the name pattern already excludes separators, but confirm containment.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name passed STORED_NAME_RE (32 hex + .webp, no separators) and an HMAC check, and containment is re-verified on the next line
    const resolved = path.resolve(UPLOADS_DIR, name); // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal -- same
    if (path.dirname(resolved) !== UPLOADS_DIR) return res.status(404).json({ error: 'Not found' });

    const remaining = Math.max(0, Number(exp) - Math.floor(Date.now() / 1000));
    // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile -- resolved is a verified server-generated name directly inside UPLOADS_DIR (checks above)
    res.sendFile(resolved, {
      dotfiles: 'deny',
      etag: false,
      lastModified: false,
      cacheControl: false,
      headers: {
        'Content-Type': 'image/webp',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': `private, max-age=${remaining}`,
      },
    }, (err) => {
      if (err && !res.headersSent) res.status(err.status === 404 || err.code === 'ENOENT' ? 404 : 500).json({ error: 'Not found' });
    });
  });
}

// --- PDF text extraction -----------------------------------------------------------------

// Runs a worker script with a hard deadline and memory ceiling. pdf-parse cannot be cancelled
// in-process (and a pathological document can spin synchronously), so extraction lives in a
// worker thread that is terminated on timeout; the main event loop is never held.
function runWorker(file, workerData, { timeoutMs = PDF_PARSE_TIMEOUT_MS, memoryMb = PDF_WORKER_MEMORY_MB } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, {
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new UploadError(`This PDF took longer than ${Math.round(timeoutMs / 1000)}s to read and was abandoned.`, 422)),
      timeoutMs,
    );
    // A document the parser cannot read is the client's problem (corrupt, truncated, encrypted).
    worker.once('message', (message) => (
      message.ok ? finish(resolve, message.result) : finish(reject, new UploadError('This PDF could not be read. It may be damaged or password-protected.', 422))
    ));
    worker.once('error', (err) => finish(
      reject,
      err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new UploadError('This PDF is too complex to read and was abandoned.', 422) : err,
    ));
    worker.once('exit', (code) => finish(reject, new Error(`PDF worker exited unexpectedly (code ${code})`)));
  });
}

// Reads at most MAX_PDF_PAGES + 1 pages (see lib/pdf-text.js) and rejects, rather than
// truncates, over-long documents so invoice lines are never silently lost.
async function extractPdfText(filePath, options) {
  return heavyWork.run(() => extractPdfTextUngated(filePath, options));
}

async function extractPdfTextUngated(filePath, options) {
  const data = await fs.promises.readFile(filePath);
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new UploadError('The uploaded file is not a PDF.');
  const result = await runWorker(PDF_WORKER_FILE, { data, maxPages: MAX_PDF_PAGES }, options);
  if (result.total > MAX_PDF_PAGES) {
    throw new UploadError(`This PDF has ${result.total} pages; invoices are limited to ${MAX_PDF_PAGES} pages.`, 422);
  }
  return result.text;
}

module.exports = {
  imageUpload,
  invoiceUpload,
  discardUpload,
  openValidatedImage,
  storeUploadedImage,
  extractPdfText,
  runWorker,
  prepareScratchDir,
  signMediaUrl,
  verifyMediaSignature,
  withSignedImage,
  registerMediaRoute,
  uploadErrorStatus,
  sendUploadError,
  heavyWork,
  UploadError,
  MAX_PDF_PAGES,
};
