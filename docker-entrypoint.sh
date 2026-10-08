#!/bin/sh
# Container entrypoint: while still root, make the writable paths belong to PUID:PGID, then
# drop privileges permanently and exec the app (so node, not a shell, is PID 1 and receives
# SIGTERM/SIGINT directly — lib/shutdown.js relies on that for graceful shutdown).
#
# Environment:
#   PUID  numeric user id to run as   (default 99  — unRAID "nobody")
#   PGID  numeric group id to run as  (default 100 — unRAID "users")
#   LOG_DIR defaults to <dir of DB_PATH>/logs, i.e. /app/data/logs on the persistent data mount.
#   DB_PATH, LOG_DIR, UPLOADS_DIR  honoured if set, so their directories are prepared too — but
#   only inside /app (validated below; the container refuses to start otherwise).
#   UPLOADS_DIR defaults to /app/public/uploads, the path unRAID bind-mounts (same default as
#   lib/config.js; the Dockerfile sets it explicitly).
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"

case "$PUID$PGID" in
  ''|*[!0-9]*) echo "entrypoint: PUID and PGID must be numeric (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;;
esac
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "entrypoint: refusing to run the app as root; set PUID/PGID to a non-zero id" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  # Started with --user: nothing to prepare or drop, just run.
  exec "$@"
fi

# Everything below runs as root and chowns recursively, so the paths are validated first: a
# mistyped DB_PATH (say /x.db, whose directory is /) must stop the container, not chown it.
# lib/config.js (validateStoragePaths) applies the same rules; test/entrypoint.test.js runs both
# over one table of cases to keep them in agreement.
APP_ROOT=/app

# Writable paths must be absolute, normalised (no //, ., .. or trailing slash), made only of
# [A-Za-z0-9._-] segments, strictly inside $APP_ROOT, and not part of the application code.
check_path() {
  name="$1"; value="$2"
  case "$value" in
    '') echo "entrypoint: $name is empty" >&2; exit 1 ;;
    /*) ;;
    *) echo "entrypoint: $name must be an absolute path" >&2; exit 1 ;;
  esac
  case "$value" in
    *[!A-Za-z0-9._/-]*|*//*|*/./*|*/../*|*/.|*/..|*/)
      echo "entrypoint: $name must be a normalised path of letters, digits, '.', '_' and '-' (no '//', '.', '..' or trailing '/')" >&2; exit 1 ;;
  esac
  case "$value" in
    "$APP_ROOT"/*) ;;
    *) echo "entrypoint: $name must be inside $APP_ROOT (got a path outside it)" >&2; exit 1 ;;
  esac
  case "$value" in
    "$APP_ROOT"/node_modules|"$APP_ROOT"/node_modules/*|"$APP_ROOT"/lib|"$APP_ROOT"/lib/*|\
    "$APP_ROOT"/routes|"$APP_ROOT"/routes/*|"$APP_ROOT"/parsers|"$APP_ROOT"/parsers/*|\
    "$APP_ROOT"/scripts|"$APP_ROOT"/scripts/*|"$APP_ROOT"/client|"$APP_ROOT"/client/*|"$APP_ROOT"/public)
      echo "entrypoint: $name must not be inside the application code ($APP_ROOT)" >&2; exit 1 ;;
  esac
}

# Two writable directories may not be the same or nested: chowning one would reach the other.
check_disjoint() {
  case "$2/" in "$4"/*) ;; *) case "$4/" in "$2"/*) ;; *) return 0 ;; esac ;; esac
  echo "entrypoint: $1 and $3 must be separate directories (neither may contain the other)" >&2
  exit 1
}

DB_FILE="${DB_PATH:-$APP_ROOT/data/inventory.db}"
check_path DB_PATH "$DB_FILE"
DATA_DIR="$(dirname "$DB_FILE")"
UPLOADS="${UPLOADS_DIR:-$APP_ROOT/public/uploads}"
LOGS="${LOG_DIR:-$DATA_DIR/logs}"
check_path "the DB_PATH directory" "$DATA_DIR"
check_path UPLOADS_DIR "$UPLOADS"
check_path LOG_DIR "$LOGS"
check_disjoint "the DB_PATH directory" "$DATA_DIR" UPLOADS_DIR "$UPLOADS"
# The logs live on the persistent data mount by default, so LOG_DIR may sit inside the data
# directory; it may not be, or contain, the data directory itself.
case "$DATA_DIR/" in "$LOGS"/*) echo "entrypoint: LOG_DIR must not be, or contain, the DB_PATH directory" >&2; exit 1 ;; esac
check_disjoint UPLOADS_DIR "$UPLOADS" LOG_DIR "$LOGS"

REAL_ROOT="$(realpath "$APP_ROOT")"
for dir in "$DATA_DIR" "$UPLOADS" "$LOGS"; do
  mkdir -p "$dir"
  # A symlink inside the image or a bind mount must not redirect the chown out of the app.
  case "$(realpath "$dir")/" in
    "$REAL_ROOT"/?*) ;;
    *) echo "entrypoint: $dir resolves outside $APP_ROOT; refusing to chown it" >&2; exit 1 ;;
  esac
  # Only touch entries that are not already correct, so restarts are cheap and a bind mount
  # first populated by root (e.g. an existing inventory.db) is migrated in place.
  find "$dir" -xdev \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
done

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs "$@"
