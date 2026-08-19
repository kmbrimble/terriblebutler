// Plain TypeScript, no React or DOM-library imports — same reasoning as api.ts.
import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';

let socket: Socket | undefined;

// Mirrors public/index.html's socket wiring exactly: a single lazily-created,
// autoConnect-disabled instance, (re)authenticated with the current tb_token on connect.
export function connectSocket(): Socket {
  if (!socket) {
    socket = io({ autoConnect: false });
  }
  socket.auth = { token: getToken() ?? '' };
  socket.connect();
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
}
