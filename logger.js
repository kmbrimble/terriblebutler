// Verbose action logging (#14): every mutating API call, to both stdout (docker logs) and a
// weekly-rotated file. One file per week means "rotation" is just a new filename — no rename
// step, and pruning is the same mtime-cutoff approach as backup.js.
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const MAX_AGE_DAYS = 30;
const REDACT_KEYS = ['password', 'token'];

function weekStartLabel(date = new Date()) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // days since Monday, 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function currentLogFile() {
  return path.join(LOG_DIR, `actions-${weekStartLabel()}.log`);
}

function sanitize(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...body };
  for (const key of REDACT_KEYS) {
    if (key in clone) clone[key] = '***';
  }
  return clone;
}

function pruneOldLogs(maxAgeDays = MAX_AGE_DAYS) {
  if (!fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(LOG_DIR)) {
    if (!/^actions-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
    const full = path.join(LOG_DIR, file);
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
  }
}

function logAction(entry) {
  const record = {
    time: new Date().toISOString(),
    ...entry,
    request_body: sanitize(entry.request_body),
    response_body: sanitize(entry.response_body),
  };
  const line = JSON.stringify(record);
  console.log(`[Action] ${line}`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(currentLogFile(), line + '\n');
  pruneOldLogs();
}

module.exports = { logAction, pruneOldLogs, weekStartLabel, currentLogFile, LOG_DIR };
