#!/bin/sh
# Docker smoke test for the runtime image: builds it, runs it with throwaway named volumes and
# dummy-but-valid credentials, and checks health, the non-root drop, ownership of the writable
# paths, the entrypoint's path refusal, and a graceful SIGTERM stop. Everything it creates is
# prefixed `smoketest-` and removed on exit. It never uses bind mounts, so it is safe against a
# shared (e.g. unRAID) docker daemon. Not part of CI; run: scripts/docker-smoke.sh [image-tag]
set -eu

TAG="${1:-smoketest-butler:local}"
SUFFIX="$$"
NAME="smoketest-butler-$SUFFIX"
VOL_DATA="smoketest-data-$SUFFIX"
VOL_UPLOADS="smoketest-uploads-$SUFFIX"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

cleanup() {
  docker rm -f "$NAME" "$NAME-bad" >/dev/null 2>&1 || true
  docker volume rm "$VOL_DATA" "$VOL_UPLOADS" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "$(dirname "$0")/.."
docker build -q -t "$TAG" . >/dev/null || fail "image build failed"

# A well-formed bcrypt hash of a throwaway password; the secret is random per run.
HASH="$(docker run --rm "$TAG" node scripts/generate-password-hash.js 'smoketest-password' | tail -n 1)"
JWT="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

docker volume create "$VOL_DATA" >/dev/null
docker volume create "$VOL_UPLOADS" >/dev/null
docker run -d --name "$NAME" \
  -e AUTH_USERNAME=smoketest -e "AUTH_PASSWORD_HASH=$HASH" -e "JWT_SECRET=$JWT" \
  -e ANTHROPIC_API_KEY=sk-ant-smoketest-dummy -e PUID=1234 -e PGID=5678 \
  -v "$VOL_DATA:/app/data" -v "$VOL_UPLOADS:/app/public/uploads" "$TAG" >/dev/null

# Requests run inside the container (node's fetch), so they hit the app itself whatever the
# host's port mapping or proxying looks like.
call() { docker exec -e "T=${3:-}" "$NAME" node -e '
  const [method, path, body] = process.argv.slice(1);
  const headers = { "content-type": "application/json" };
  if (process.env.T) headers.authorization = `Bearer ${process.env.T}`;
  fetch(`http://127.0.0.1:2626${path}`, { method, headers, body: body || undefined }).then(async (r) => {
    process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1);
  }).catch((e) => { console.error(e.message); process.exit(1); });' "$1" "$2" "$4"; }
i=0
until call GET /api/health "" "" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 30 ] || { docker logs "$NAME" >&2; fail "health check never passed"; }
  sleep 1
done
echo "ok: /api/health"

PID1_UID="$(docker exec "$NAME" sh -c 'awk "/^Uid:/{print \$2}" /proc/1/status')"
[ "$PID1_UID" = 1234 ] || fail "PID 1 runs as uid $PID1_UID, expected 1234"
docker exec "$NAME" sh -c 'grep -q "^NoNewPrivs:[[:space:]]*1" /proc/1/status' || fail "no-new-privs not set"
[ "$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')" = "node server.js " ] || fail "PID 1 is not node"
echo "ok: app is PID 1, uid 1234, no-new-privs"

for d in /app/data /app/public/uploads /app/logs; do
  OWNER="$(docker exec "$NAME" stat -c '%u:%g' "$d")"
  [ "$OWNER" = 1234:5678 ] || fail "$d owned by $OWNER"
done
[ "$(docker exec "$NAME" stat -c '%u' /app/server.js)" = 0 ] || fail "app source is not root-owned"
docker exec "$NAME" test ! -e /app/client/src || fail "client source present in the runtime image"
docker exec "$NAME" test -f /app/client/dist/index.html || fail "client build output missing"
echo "ok: ownership and image contents"

# A mutating call must reach the action log on stdout (what `docker logs` shows).
LOGIN="$(call POST /api/auth/login '' '{"username":"smoketest","password":"smoketest-password"}' || true)"
TOKEN="$(printf '%s' "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { docker logs "$NAME" >&2; fail "login failed: $LOGIN"; }
call POST /api/locations "$TOKEN" '{"name":"Smoke location"}' >/dev/null || fail "POST /api/locations failed"
sleep 1
docker logs "$NAME" 2>&1 | grep -q '^\[Action\] .*"path":"/api/locations"' || { docker logs "$NAME" >&2; fail "action log line missing from docker logs"; }
echo "ok: action log reaches docker logs"

# A mistyped DB_PATH must stop the container, not chown the filesystem.
set +e
docker run --name "$NAME-bad" -e DB_PATH=/x.db -e AUTH_USERNAME=u -e "AUTH_PASSWORD_HASH=$HASH" \
  -e "JWT_SECRET=$JWT" "$TAG" >/dev/null 2>"/tmp/$NAME-bad.err"
BAD=$?
set -e
[ "$BAD" -ne 0 ] || fail "container started with DB_PATH=/x.db"
grep -q "must be inside /app" "/tmp/$NAME-bad.err" || { cat "/tmp/$NAME-bad.err" >&2; fail "no clear refusal message"; }
rm -f "/tmp/$NAME-bad.err"
echo "ok: bad DB_PATH refused"

docker stop -t 15 "$NAME" >/dev/null
CODE="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$CODE" = 0 ] || { docker logs "$NAME" >&2; fail "graceful stop exited $CODE"; }
echo "ok: graceful stop (exit 0)"
echo "SMOKE PASS"
