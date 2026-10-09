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

# Everything the app creates (database and its WAL, action logs, backups, stored images) is private to the
# app user: owner-only, nothing readable by group or other. The app also sets these modes itself, so they
# hold under any umask; this covers anything created before the app starts. It applies to the --user
# path below as well, and is inherited across the privilege drop.
umask 077

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

# True when $1 is $2 or lies inside it (both already normalised: no trailing slash).
is_within() {
  case "$1/" in
    "$2"/*) return 0 ;;
  esac
  return 1
}

# Two writable directories may not be the same or nested: chowning one would reach the other.
check_disjoint() {
  if is_within "$2" "$4" || is_within "$4" "$2"; then
    echo "entrypoint: $1 and $3 must be separate directories (neither may contain the other)" >&2
    exit 1
  fi
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
if is_within "$DATA_DIR" "$LOGS"; then
  echo "entrypoint: LOG_DIR must not be, or contain, the DB_PATH directory" >&2
  exit 1
fi
check_disjoint UPLOADS_DIR "$UPLOADS" LOG_DIR "$LOGS"

# Directories 0700 and files 0600 throughout one volume (-xdev), repairing what an earlier version (umask
# 022) left readable. Scoped like the chown: find does not follow symbolic links and -type d / -type f never
# match one, so a link inside the data cannot point this at something outside it; only entries that are
# not already right are touched. (A link swapped in between find and chmod would be followed by chmod, but
# this runs before the app starts, with nothing unprivileged running in this container.)
repair_modes() {
  find "$1" -xdev -type d ! -perm 0700 -exec chmod 0700 {} +
  find "$1" -xdev -type f ! -perm 0600 -exec chmod 0600 {} +
}

REAL_ROOT="$(realpath "$APP_ROOT")"
for dir in "$DATA_DIR" "$UPLOADS" "$LOGS"; do
  # Any missing parents (a custom DB_PATH/LOG_DIR/UPLOADS_DIR such as /app/var/log) stay traversable: under the
  # umask 077 above they would be 0700 root-owned and the app could not reach its own directory. repair_modes
  # below narrows the target itself to 0700.
  (umask 022 && mkdir -p "$dir")
  # A symlink inside the image or a bind mount must not redirect the chown out of the app.
  case "$(realpath "$dir")/" in
    "$REAL_ROOT"/?*) ;;
    *) echo "entrypoint: $dir resolves outside $APP_ROOT; refusing to chown it" >&2; exit 1 ;;
  esac
  # Only touch entries that are not already correct, so restarts are cheap and a bind mount
  # first populated by root (e.g. an existing inventory.db) is migrated in place.
  find "$dir" -xdev \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
  repair_modes "$dir"
done

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs "$@"
