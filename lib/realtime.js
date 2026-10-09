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
// peer), then the IPv6 /64 fold of keyForAddress. Open connections are counted per client and
// overall from engine.io's own connection/close events, which cover not-yet-authenticated ones.
function createConnectionLimiter({ io, trustPeer, handshakeMax, perClientMax, totalMax }) {
  const handshakes = createHitCounter({ windowMs: 60 * 1000, maxRequests: handshakeMax, bucketName: 'socket-handshake' });
  const open = new Map();
  const keyOf = (req) => keyForAddress((proxyaddr(req, trustPeer) || req.socket.remoteAddress || 'unknown').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1'));

  io.engine.on('connection', (rawSocket) => {
    const key = keyOf(rawSocket.request);
    open.set(key, (open.get(key) || 0) + 1);
    rawSocket.once('close', () => {
      const left = (open.get(key) || 1) - 1;
      if (left > 0) open.set(key, left);
      else open.delete(key);
    });
  });

  // ponytail: a session is counted when engine.io emits 'connection', which is after allowRequest passes,
  // so a burst of simultaneous handshakes from one client can all clear perClientMax before any is
  // counted. The per-minute handshake limit bounds that burst (a ceiling, not a hole); count
  // in-flight handshakes here if it ever matters.
  // Returns an error message to refuse the handshake, or null to let it through.
  function check(req) {
    const key = keyOf(req);
    if (handshakes.hit(key).limited) return 'Too many connection attempts';
    if (io.engine.clientsCount >= totalMax) return 'Too many open connections';
    if ((open.get(key) || 0) >= perClientMax) return 'Too many open connections from this client';
    return null;
  }
  return { check };
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
  const connectionLimiter = createConnectionLimiter({
    io,
    trustPeer,
    handshakeMax: limits.handshakeMax ?? 60,
    perClientMax: limits.perClientMax ?? 20,
    totalMax: limits.totalMax ?? 200,
  });

  io.use((socket, next) => {
    const credential = authenticateToken(socket.handshake.auth?.token);
    if (!credential) {
      return next(new Error('Unauthorized'));
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

  return { io, broadcastUpdate, disconnectSockets };
}

module.exports = { createRealtime, watchExpiry, isOriginAllowed };
