const { Server } = require('socket.io');

// Which Origin may open a socket. WebSocket handshakes are not subject to CORS, so the
// `cors` option alone restricts nothing there; this runs in engine.io's allowRequest hook
// (every polling handshake and every upgrade). With APP_ORIGIN set, only that origin is
// accepted; otherwise the Origin's host must equal the request Host (same-origin). A
// missing Origin is let through: browsers omit it on same-origin polling GETs and native
// clients never send one, and the socket still needs a valid token at the handshake.
// A present-but-malformed or mismatching Origin is refused.
function isOriginAllowed(req, appOrigin) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (appOrigin) return parsed.origin === appOrigin;
  return parsed.host === req.headers.host;
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

// Socket.IO needs the HTTP server (which needs `app`), but route handlers need
// broadcastUpdate — this factory is the seam that breaks that cycle: the composition
// root builds `server` from `app` first, then calls this to get `io`/`broadcastUpdate`
// before registering any routes.
function createRealtime(server, authenticateToken, credentialExpiry = (c) => c.expiresAt) {
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
    allowRequest: (req, callback) => callback(null, isOriginAllowed(req, appOrigin)),
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

module.exports = { createRealtime, watchExpiry };
