#!/bin/sh
# Container entrypoint: while still root, make the writable paths belong to PUID:PGID, then
# drop privileges permanently and exec the app (so node, not a shell, is PID 1 and receives
# SIGTERM/SIGINT directly — lib/shutdown.js relies on that for graceful shutdown).
#
# Environment:
#   PUID  numeric user id to run as   (default 99  — unRAID "nobody")
#   PGID  numeric group id to run as  (default 100 — unRAID "users")
#   DB_PATH, LOG_DIR  honoured if set, so their parent directories are prepared too.
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

DATA_DIR="/app/data"
[ -n "${DB_PATH:-}" ] && DATA_DIR="$(dirname "$DB_PATH")"

for dir in "$DATA_DIR" /app/uploads /app/public/uploads "${LOG_DIR:-/app/logs}"; do
  mkdir -p "$dir"
  # Only touch entries that are not already correct, so restarts are cheap and a bind mount
  # first populated by root (e.g. an existing inventory.db) is migrated in place.
  find "$dir" -xdev \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
done

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs "$@"
