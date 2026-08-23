const { Server } = require('socket.io');

// Socket.IO needs the HTTP server (which needs `app`), but route handlers need
// broadcastUpdate — this factory is the seam that breaks that cycle: the composition
// root builds `server` from `app` first, then calls this to get `io`/`broadcastUpdate`
// before registering any routes.
function createRealtime(server, authenticateToken) {
  const io = new Server(server, {
    cors: { origin: process.env.APP_ORIGIN || true }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token || !authenticateToken(token)) {
      return next(new Error('Unauthorized'));
    }
    next();
  });
  io.on('connection', (socket) => {
    console.log('A client connected');
    socket.on('disconnect', () => {
      console.log('A client disconnected');
    });
  });

  function broadcastUpdate(action, itemData) {
    io.emit('inventory_updated', { action, item: itemData });
    if (action === 'locations_updated' || action === 'categories_updated') {
      io.emit(action, itemData);
    }
  }

  return { io, broadcastUpdate };
}

module.exports = { createRealtime };
