// Everything the app writes to persistent storage (database and WAL, action logs, backups, stored
// images) is owner-only, whatever umask the process inherited: directories it creates are 0700 and files
// 0600. The container entrypoint sets umask 077 and repairs existing contents (docker-entrypoint.sh);
// this is the same rule enforced by the app itself, so it also holds when the app is started directly.
const fs = require('fs');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Creates `dir` (and any missing parents) as 0700. A directory that already exists is left exactly as
// it is: it may be a shared mount or a system directory (DB_PATH can point into /tmp), and changing
// someone else's permissions is not this module's job. (mkdir's mode is only ever narrowed by umask.)
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

// Makes a file the app owns 0600. A missing file is fine; a file this user may not chmod is reported,
// not fatal (the entrypoint's repair covers the container case).
function makePrivate(file) {
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    console.warn('[Permissions] could not make %s private: %s', file, err.message);
  }
}

module.exports = { ensurePrivateDir, makePrivate, DIR_MODE, FILE_MODE };
