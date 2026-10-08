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

// Socket.IO needs the HTTP server (which needs `app`), but route handlers need
// broadcastUpdate — this factory is the seam that breaks that cycle: the composition
// root builds `server` from `app` first, then calls this to get `io`/`broadcastUpdate`
// before registering any routes.
function createRealtime(server, authenticateToken) {
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

module.exports = { createRealtime };
