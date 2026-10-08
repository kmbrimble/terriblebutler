// Verbose action logging (#14): every authenticated mutating API call, request + response
// body, to stdout (docker logs) and a weekly-rotated file. One file per week means "rotation"
// is just a new filename — no rename step; pruning is the same mtime-cutoff approach as
// backup.js and runs when a new weekly file is opened, not on every write.
//
// File writes go through one append stream per week. Its buffer is bounded: once more than
// MAX_BUFFERED_BYTES are waiting on the disk, new entries are dropped (and counted) rather
// than queued, so a slow disk can never grow memory or stall the event loop. The first entry
// accepted after a drop is preceded by a `log_overflow` record saying how many were lost.
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const MAX_AGE_DAYS = 30;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_BODY_CHARS = 4096;
const PREVIEW_CHARS = 1024;
const MAX_REDACT_DEPTH = 8;
// Matches the key names that carry credentials: password/passwd, token, secret, authorization,
// cookie, api_key/apikey/…key, hash, credential, jwt, bearer, session.
const SENSITIVE_KEY = /pass(word|wd)?|token|secret|authori[sz]ation|cookie|key|hash|credential|jwt|bearer|session/i;

function weekStartLabel(date = new Date()) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // days since Monday, 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function currentLogFile() {
  return path.join(LOG_DIR, `actions-${weekStartLabel()}.log`);
}

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[max depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const clone = {};
  for (const [key, inner] of Object.entries(value)) {
    clone[key] = SENSITIVE_KEY.test(key) ? '***' : redact(inner, depth + 1);
  }
  return clone;
}

// Redacts, then bounds the size: a body whose JSON exceeds MAX_BODY_CHARS is replaced with a
// marker carrying the original length and a short preview.
function sanitize(body) {
  if (body === undefined || body === null || typeof body !== 'object') return body;
  const redacted = redact(body);
  const json = JSON.stringify(redacted);
  if (json.length <= MAX_BODY_CHARS) return redacted;
  return { truncated: true, original_chars: json.length, preview: json.slice(0, PREVIEW_CHARS) };
}

function pruneOldLogs(maxAgeDays = MAX_AGE_DAYS) {
  if (!fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(LOG_DIR)) {
    if (!/^actions-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
    const full = path.join(LOG_DIR, file);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch (err) {
      console.error(`[Logger] failed to prune old log ${file}:`, err.message);
    }
  }
}

let stream = null;
let streamFile = null;
let dropped = 0;

function closeStream() {
  const closing = stream;
  stream = null;
  streamFile = null;
  if (!closing) return Promise.resolve();
  return new Promise((resolve) => {
    closing.once('close', resolve);
    closing.end();
  });
}

function openStream(file) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const opened = fs.createWriteStream(file, { flags: 'a' });
  opened.on('error', (err) => {
    // A broken file must not take the process down or wedge logging: report once, drop the
    // stream, and let the next entry reopen it.
    console.error('[Logger] action log write failed:', err.message);
    if (stream === opened) {
      stream = null;
      streamFile = null;
    }
    opened.destroy();
  });
  pruneOldLogs();
  return opened;
}

// The previous week's stream is ended (not destroyed) so its buffered lines still land.
function activeStream() {
  const file = currentLogFile();
  if (stream && streamFile !== file) {
    stream.end();
    stream = null;
  }
  if (!stream) {
    stream = openStream(file);
    streamFile = file;
  }
  return stream;
}

function writeLine(line) {
  const out = activeStream();
  if (out.writableLength > MAX_BUFFERED_BYTES) {
    dropped += 1;
    return;
  }
  if (dropped) {
    out.write(JSON.stringify({ time: new Date().toISOString(), event: 'log_overflow', dropped }) + '\n');
    dropped = 0;
  }
  out.write(line + '\n');
}

function logAction(entry) {
  try {
    const record = { time: new Date().toISOString(), ...entry };
    if ('request_body' in entry) record.request_body = sanitize(entry.request_body);
    if ('response_body' in entry) record.response_body = sanitize(entry.response_body);
    const line = JSON.stringify(record);
    console.log(`[Action] ${line}`);
    writeLine(line);
  } catch (err) {
    // Logging is best-effort: it must never fail the request it describes.
    console.error('[Logger] failed to record action:', err.message);
  }
}

// Resolves once every accepted entry is on disk. Used by shutdown and by tests.
const flush = closeStream;

module.exports = { logAction, pruneOldLogs, weekStartLabel, currentLogFile, flush, sanitize, LOG_DIR, MAX_BUFFERED_BYTES };
