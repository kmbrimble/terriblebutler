// Plain TypeScript, no React or DOM-library imports — same reasoning as api.ts.
import { io, type Socket } from 'socket.io-client';
import { getToken, endSession } from './api';

let socket: Socket | undefined;

// Mirrors public/index.html's socket wiring exactly: a single lazily-created,
// autoConnect-disabled instance, (re)authenticated with the current tb_token on connect.
export function connectSocket(): Socket {
  if (!socket) {
    socket = io({ autoConnect: false });
    // lib/realtime.js's handshake middleware is the only place this server ever rejects a
    // connection, and it always rejects with this exact message — so this is the one string
    // that means "the token is bad", not a dropped connection or a server restart.
    socket.on('connect_error', (err: Error) => {
      if (err.message === 'Unauthorized') endSession();
    });
  }
  socket.auth = { token: getToken() ?? '' };
  socket.connect();
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
}

export function getSocket(): Socket | undefined {
  return socket;
}
