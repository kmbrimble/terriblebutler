// Verbose action logging (#14): every authenticated mutating API call, request + response
// body, to stdout (docker logs) and a weekly-rotated file. One file per week means "rotation"
// is just a new filename — no rename step; pruning is the same mtime-cutoff approach as
// backup.js and runs when a new weekly file is opened, not on every write.
//
// File writes go through one append stream per week. Its buffer is bounded: once more than
// MAX_BUFFERED_BYTES are waiting on the disk, new entries are dropped (and counted) rather
// than queued, so a slow disk can never grow memory or stall the event loop. The first entry
// accepted after a drop is preceded by a `log_overflow` record saying how many were lost.
//
// The stdout copy (what `docker logs` shows) is kept alongside the file. It writes through
// process.stdout (asynchronous for pipes), not a synchronous console.log, with the same bound and
// overflow record (prefixed `[Action] `), so the two copies behave alike.
// ACTION_LOG_STDOUT=0 turns the copy off (the test suite does, to keep its output readable).
const fs = require('fs');
const path = require('path');

// Defaults to <database dir>/logs, i.e. /app/data/logs in the container: the persistent data mount,
// next to the backups, so the 30-day retention survives container recreation.
const LOG_DIR = process.env.LOG_DIR
  || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'inventory.db')), 'logs');
const MAX_AGE_DAYS = 30;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const STDOUT_FLUSH_TIMEOUT_MS = 1500;
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

// Signed /media URLs (item image_path) carry a bearer-style signature in the query string.
const MEDIA_SIGNATURE = /([?&]sig=)[A-Za-z0-9_-]+/g;

function redact(value, depth = 0) {
  if (typeof value === 'string') return value.replace(MEDIA_SIGNATURE, '$1***');
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
  if (body === undefined || body === null) return body;
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
const fileState = { dropped: 0 };

// Writes one line to a bounded stream. `state.dropped` counts entries refused since the last
// accepted one; the next accepted entry is preceded by a log_overflow record.
function boundedWrite(out, state, line, prefix = '') {
  if (out.writableLength > MAX_BUFFERED_BYTES) {
    state.dropped += 1;
    return;
  }
  if (state.dropped) {
    out.write(`${prefix}${JSON.stringify({ time: new Date().toISOString(), event: 'log_overflow', dropped: state.dropped })}\n`);
    state.dropped = 0;
  }
  out.write(`${prefix}${line}\n`);
}

const stdoutState = { dropped: 0 };
let stdoutStream = null;
let stdoutBroken = false;

function adoptStdout(opened) {
  opened.on('error', (err) => {
    // A closed stdout (EPIPE) must not take the process down; the file copy carries on.
    stdoutBroken = true;
    if (stdoutStream === opened) stdoutStream = null;
    try { process.stderr.write(`[Logger] stdout action log disabled: ${err.message}\n`); } catch { /* nothing left to report to */ }
  });
  stdoutStream = opened;
}

function activeStdout() {
  if (stdoutStream) return stdoutStream;
  if (stdoutBroken || process.env.ACTION_LOG_STDOUT === '0') return null;
  // process.stdout, not a second stream on fd 1: once it exists, libuv has made a pipe fd
  // non-blocking, and a separate fs stream on it would fail with EAGAIN when the pipe fills.
  // For pipes process.stdout queues writes asynchronously and reports writableLength.
  adoptStdout(process.stdout);
  return stdoutStream;
}

// For tests: route the stdout copy to a different stream (or null to restore process.stdout).
function setStdoutStream(replacement) {
  stdoutStream = null;
  stdoutBroken = false;
  if (replacement) adoptStdout(replacement);
  stdoutState.dropped = 0;
}

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
  boundedWrite(activeStream(), fileState, line);
}

function logAction(entry) {
  try {
    const record = { time: new Date().toISOString(), ...entry };
    if ('request_body' in entry) record.request_body = sanitize(entry.request_body);
    if ('response_body' in entry) record.response_body = sanitize(entry.response_body);
    const line = JSON.stringify(record);
    const out = activeStdout();
    if (out) boundedWrite(out, stdoutState, line, '[Action] ');
    writeLine(line);
  } catch (err) {
    // Logging is best-effort: it must never fail the request it describes.
    console.error('[Logger] failed to record action:', err.message);
  }
}

// Resolves once every accepted entry is on disk and handed to stdout. Used by shutdown and tests.
// stdout is never closed; an empty write's callback fires once the writes before it are done.
function flush() {
  const out = stdoutStream;
  // A stalled reader must not hold up shutdown: wait for stdout only briefly (the file stream's
  // flush is unbounded, as it is local disk).
  const stdoutDone = out
    ? Promise.race([new Promise((resolve) => out.write('', () => resolve())), new Promise((resolve) => setTimeout(resolve, STDOUT_FLUSH_TIMEOUT_MS).unref())])
    : Promise.resolve();
  return Promise.all([closeStream(), stdoutDone]).then(() => undefined);
}

module.exports = { logAction, pruneOldLogs, weekStartLabel, currentLogFile, flush, sanitize, setStdoutStream, LOG_DIR, MAX_BUFFERED_BYTES };
