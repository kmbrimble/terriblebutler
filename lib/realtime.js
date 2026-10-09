const { Server } = require('socket.io');
const proxyaddr = require('proxy-addr');
const { createHitCounter, keyForAddress } = require('./rate-limit-core');

// Which Origin may open a socket. WebSocket handshakes are not subject to CORS, so the
// `cors` option alone restricts nothing there; this runs in engine.io's allowRequest hook
// (every polling handshake and every upgrade). With APP_ORIGIN set, only that origin is
// accepted; otherwise the Origin must equal the origin this request was made to, compared in
// full (scheme, host, port). That expected origin comes from the socket's own scheme and the
// Host header, or from X-Forwarded-Proto / X-Forwarded-Host only when the direct peer is
// trusted per TRUST_PROXY (`trustPeer(address, 0)`, Express's compiled setting), so a client
// cannot vouch for its own origin. A missing Origin is let through: browsers omit it on
// same-origin polling GETs and native clients never send one, and the socket still needs a
// valid token at the handshake. A present-but-malformed or mismatching Origin is refused.
const firstValue = (header) => String(header ?? '').split(',')[0].trim();

function expectedOrigin(req, trustPeer) {
  let proto = req.socket.encrypted ? 'https' : 'http';
  let host = req.headers.host;
  if (trustPeer(req.socket.remoteAddress, 0)) {
    const forwardedProto = firstValue(req.headers['x-forwarded-proto']).toLowerCase();
    if (forwardedProto === 'http' || forwardedProto === 'https') proto = forwardedProto;
    host = firstValue(req.headers['x-forwarded-host']) || host;
  }
  return new URL(`${proto}://${host}`).origin;
}

function isOriginAllowed(req, appOrigin, trustPeer = () => false) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    if (appOrigin) return parsed.origin === appOrigin;
    return parsed.origin === expectedOrigin(req, trustPeer);
  } catch {
    return false;
  }
}

// setTimeout fires immediately for delays above 2^31-1 ms (~24.8 days), and a 30-day JWT is
// longer than that. Re-checking at least daily also picks up a sliding device-token expiry.
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

// Drops the socket when its credential expires, so a connection never outlives the token it
// authenticated with. `getExpiry(credential)` returns the current expiry (epoch ms) or null
// if the credential is no longer valid; it is re-read whenever the timer fires, and the
// timer is cleared when the socket goes away so nothing leaks.
function watchExpiry(socket, getExpiry) {
  let timer;
  function drop() {
    socket.emit('session_revoked');
    socket.disconnect(true);
  }
  function schedule(expiresAt) {
    timer = setTimeout(check, Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_MS));
    timer.unref();
  }
  function check() {
    let expiresAt;
    try {
      expiresAt = getExpiry(socket.data.credential);
    } catch (err) {
      console.error('Socket credential re-check failed; disconnecting.', err);
      return drop();
    }
    if (!expiresAt || expiresAt <= Date.now()) return drop();
    schedule(expiresAt);
  }
  socket.once('disconnect', () => clearTimeout(timer));
  schedule(socket.data.credential.expiresAt);
}

// Connection limits. engine.io calls allowRequest once per new session (the handshake: a polling
// GET or a direct WebSocket upgrade with no sid), before any authentication, so this is where an
// anonymous client's cost is bounded. The client is identified exactly as Express does it:
// proxy-addr against the same compiled TRUST_PROXY function (X-Forwarded-For only from a trusted
// peer), then the IPv6 /64 fold of keyForAddress.
//
// A slot is reserved atomically in allowRequest, in the same synchronous step that checks the caps,
// and counts as "pending" until engine.io emits 'connection' for that very request (engine.io
// awaits generateId and the upgrade between the two, so a burst of simultaneous handshakes would
// otherwise all pass the check before any is counted). From then on the slot is "open" until the
// engine session closes. A pending slot that never becomes a session is released by whichever comes
// first: engine.io's 'connection_error' for the request, or PENDING_TTL_MS. Counts therefore never
// leak, and the caps hold under any burst.
const PENDING_TTL_MS = 10 * 1000;
const REFUSED_CLOSE_DELAY_MS = 250;

function createConnectionLimiter({ io, trustPeer, handshakeMax, perClientMax, totalMax, pendingTtlMs = PENDING_TTL_MS }) {
  const handshakes = createHitCounter({ windowMs: 60 * 1000, maxRequests: handshakeMax, bucketName: 'socket-handshake' });
  const open = new Map(); // client key -> open engine sessions
  const pendingByKey = new Map(); // client key -> reserved, not yet connected
  const pending = new Map(); // request -> { key, timer }
  let openTotal = 0;
  const keyOf = (req) => keyForAddress((proxyaddr(req, trustPeer) || req.socket.remoteAddress || 'unknown').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1'));
  const decrement = (map, key) => {
    const left = (map.get(key) || 1) - 1;
    if (left > 0) map.set(key, left);
    else map.delete(key);
  };

  function release(req) {
    const reservation = pending.get(req);
    if (!reservation) return;
    clearTimeout(reservation.timer);
    pending.delete(req);
    decrement(pendingByKey, reservation.key);
  }

  io.engine.on('connection', (rawSocket) => {
    const key = keyOf(rawSocket.request);
    release(rawSocket.request); // the reservation becomes this open session
    open.set(key, (open.get(key) || 0) + 1);
    openTotal += 1;
    rawSocket.once('close', () => {
      decrement(open, key);
      openTotal -= 1;
    });
  });
  // The handshake was refused or failed after allowRequest had passed it.
  io.engine.on('connection_error', (error) => release(error.req));

  // Returns an error message to refuse the handshake, or null to let it through, in which case a
  // slot is now reserved for this request.
  function check(req) {
    const key = keyOf(req);
    if (handshakes.hit(key).limited) return 'Too many connection attempts';
    if (openTotal + pending.size >= totalMax) return 'Too many open connections';
    if ((open.get(key) || 0) + (pendingByKey.get(key) || 0) >= perClientMax) return 'Too many open connections from this client';
    const timer = setTimeout(() => release(req), pendingTtlMs);
    timer.unref();
    pending.set(req, { key, timer });
    pendingByKey.set(key, (pendingByKey.get(key) || 0) + 1);
    return null;
  }

  // For tests and diagnostics.
  const stats = () => ({ open: openTotal, pending: pending.size, openClients: open.size, pendingClients: pendingByKey.size });
  return { check, stats };
}

// Socket.IO needs the HTTP server (which needs `app`), but route handlers need
// broadcastUpdate — this factory is the seam that breaks that cycle: the composition
// root builds `server` from `app` first, then calls this to get `io`/`broadcastUpdate`
// before registering any routes.
function createRealtime(server, authenticateToken, credentialExpiry = (c) => c.expiresAt, trustPeer = () => false, limits = {}) {
  let appOrigin;
  if (process.env.APP_ORIGIN) {
    try {
      appOrigin = new URL(process.env.APP_ORIGIN).origin;
    } catch {
      throw new Error('APP_ORIGIN must be a valid origin such as https://butler.example.com');
    }
  }

  const io = new Server(server, {
    // Same policy as allowRequest: no CORS headers at all unless an origin is configured.
    cors: { origin: appOrigin || false },
    allowRequest: (req, callback) => {
      if (!isOriginAllowed(req, appOrigin, trustPeer)) return callback(null, false);
      const refusal = connectionLimiter.check(req);
      return refusal ? callback(refusal, false) : callback(null, true);
    },
  });
  // Tests only: a slow or failing id source widens or breaks the gap between allowRequest and the session.
  if (limits.generateId) io.engine.generateId = limits.generateId;
  const connectionLimiter = createConnectionLimiter({
    io,
    trustPeer,
    handshakeMax: limits.handshakeMax ?? 60,
    perClientMax: limits.perClientMax ?? 20,
    totalMax: limits.totalMax ?? 200,
    pendingTtlMs: limits.pendingTtlMs,
  });

  io.use((socket, next) => {
    const credential = authenticateToken(socket.handshake.auth?.token);
    if (!credential) {
      next(new Error('Unauthorized'));
      // Nothing else will use this engine session, so end it rather than leave an anonymous
      // connection holding a slot. Socket.IO queues the CONNECT_ERROR packet after this middleware
      // returns, so the close waits a moment to let the client read why it was refused.
      const conn = socket.client.conn;
      setTimeout(() => conn.close(), REFUSED_CLOSE_DELAY_MS).unref();
      return;
    }
    // Remembered so the socket can be dropped when this credential is revoked.
    socket.data.credential = credential;
    next();
  });
  io.on('connection', (socket) => {
    console.log('A client connected');
    watchExpiry(socket, credentialExpiry);
    socket.on('disconnect', () => {
      console.log('A client disconnected');
    });
  });

  // Drops every connected socket whose credential matches. 'session_revoked' lets the
  // client end its session instead of sitting on a dead connection; a server-initiated
  // disconnect is not auto-reconnected by socket.io-client.
  function disconnectSockets(matches) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.credential && matches(socket.data.credential)) {
        socket.emit('session_revoked');
        socket.disconnect(true);
      }
    }
  }

  function broadcastUpdate(action, itemData) {
    io.emit('inventory_updated', { action, item: itemData });
    if (action === 'locations_updated' || action === 'categories_updated') {
      io.emit(action, itemData);
    }
  }

  return { io, broadcastUpdate, disconnectSockets, connectionStats: connectionLimiter.stats };
}

module.exports = { createRealtime, watchExpiry, isOriginAllowed };
