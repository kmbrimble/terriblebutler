import { useEffect, useState } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { ItemList } from './components/ItemList';
import { Toast } from './components/Toast';
import { getToken, onAuthExpired } from './lib/api';
import { connectSocket, disconnectSocket } from './lib/socket';

export function App() {
  const [loggedIn, setLoggedIn] = useState(() => Boolean(getToken()));
  const [socketConnected, setSocketConnected] = useState(false);

  // Any 401 or handshake auth failure ends up here via onAuthExpired (see api.ts); the effect
  // below already tears the socket down when loggedIn flips to false.
  useEffect(() => onAuthExpired(() => setLoggedIn(false)), []);

  useEffect(() => {
    if (!loggedIn) return undefined;

    const socket = connectSocket();
    const handleConnect = () => setSocketConnected(true);
    const handleDisconnect = () => setSocketConnected(false);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      disconnectSocket();
      setSocketConnected(false);
    };
  }, [loggedIn]);

  if (!loggedIn) {
    return (
      <>
        <LoginScreen onLoggedIn={() => setLoggedIn(true)} />
        <Toast />
      </>
    );
  }

  return (
    <div data-testid="app-root" data-socket-connected={socketConnected} className="min-h-screen bg-rimmy-black text-rimmy-text">
      <ItemList />
      <Toast />
    </div>
  );
}
