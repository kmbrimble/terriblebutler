// Everything about user-supplied files lives here: the private multer scratch area, image
// validation and re-encoding, the signed-URL scheme for stored images, the delivery route, and
// bounded PDF text extraction.
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
const { PDFParse } = require('pdf-parse');
const config = require('./config');

const { UPLOADS_DIR, UPLOAD_TMP_DIR, MAX_IMAGE_PIXELS, MAX_PDF_PAGES } = config;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });

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
  return err instanceof UploadError ? err.status : null;
}

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
    if (err.code !== 'ENOENT') console.error(`[Uploads] Failed to remove scratch file ${path.basename(file.path)}:`, err.message);
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
  crypto.hkdfSync('sha256', config.JWT_SECRET, Buffer.alloc(0), 'butler/media-url/v1', 32)
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

function registerMediaRoute(app) {
  app.get('/media/:name', (req, res) => {
    const { name } = req.params;
    const { exp, sig } = req.query;
    if (!STORED_NAME_RE.test(name)) return res.status(404).json({ error: 'Not found' });
    if (typeof exp !== 'string' || typeof sig !== 'string' || !verifyMediaSignature(name, exp, sig)) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    // Belt and braces: the name pattern already excludes separators, but confirm containment.
    const resolved = path.resolve(UPLOADS_DIR, name);
    if (path.dirname(resolved) !== UPLOADS_DIR) return res.status(404).json({ error: 'Not found' });

    const remaining = Math.max(0, Number(exp) - Math.floor(Date.now() / 1000));
    res.sendFile(resolved, {
      dotfiles: 'deny',
      etag: false,
      lastModified: false,
      cacheControl: false,
      headers: {
        'Content-Type': 'image/webp',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': `private, max-age=${remaining}`,
      },
    }, (err) => {
      if (err && !res.headersSent) res.status(err.status === 404 || err.code === 'ENOENT' ? 404 : 500).json({ error: 'Not found' });
    });
  });
}

// Middleware for any express.static mount whose root contains UPLOADS_DIR (the default
// public/uploads does): answers 404 for anything that resolves into the uploads directory.
// It checks the decoded, normalised path; a prefix match on the raw URL is bypassed by
// %-encoding (/%75ploads), repeated slashes and encoded separators.
function denyUploadsUnder(staticRoot, uploadsDir = UPLOADS_DIR) {
  const root = path.resolve(staticRoot);
  const uploadsRel = path.relative(root, uploadsDir);
  return (req, res, next) => {
    let requested;
    try {
      requested = path.resolve(root, '.' + path.posix.normalize(decodeURIComponent(req.path)));
    } catch {
      return res.status(400).json({ error: 'Bad request' });
    }
    const rel = path.relative(root, requested);
    if (rel === uploadsRel || rel.startsWith(uploadsRel + path.sep)) {
      return res.status(404).json({ error: 'Not found' });
    }
    next();
  };
}

// --- PDF text extraction -----------------------------------------------------------------

// Reads at most MAX_PDF_PAGES + 1 pages, enough to know whether the limit is exceeded, and
// rejects (rather than truncates) over-long documents so invoice lines are never silently lost.
async function extractPdfText(filePath) {
  const data = await fs.promises.readFile(filePath);
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new UploadError('The uploaded file is not a PDF.');
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ first: MAX_PDF_PAGES + 1 });
    if (result.total > MAX_PDF_PAGES) {
      throw new UploadError(`This PDF has ${result.total} pages; invoices are limited to ${MAX_PDF_PAGES} pages.`, 422);
    }
    return result.text;
  } finally {
    await parser.destroy().catch((err) => console.error('[Uploads] PDF parser cleanup failed:', err.message));
  }
}

module.exports = {
  imageUpload,
  invoiceUpload,
  discardUpload,
  openValidatedImage,
  storeUploadedImage,
  extractPdfText,
  signMediaUrl,
  verifyMediaSignature,
  withSignedImage,
  registerMediaRoute,
  denyUploadsUnder,
  uploadErrorStatus,
  UploadError,
  MAX_PDF_PAGES,
};
