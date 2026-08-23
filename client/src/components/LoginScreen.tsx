import { useState, type FormEvent } from 'react';
import { login, rememberDevice } from '../lib/api';
import { showToast } from '../lib/toast';

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberDeviceChecked, setRememberDeviceChecked] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await login(username, password);
      if (rememberDeviceChecked && deviceLabel.trim()) {
        try {
          await rememberDevice(deviceLabel.trim());
        } catch {
          showToast('Could not remember this device — you will need to log in again next time.', 'error');
        }
      }
      setError(null);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    }
  }

  return (
    <div
      data-testid="login-screen"
      className="fixed inset-0 z-50 flex items-center justify-center bg-rimmy-black px-4"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-rimmy-charcoal border border-rimmy-border rounded-lg p-6 w-full max-w-xs space-y-4 shadow-lg"
      >
        <h1 className="text-2xl text-rimmy-orange leading-none" style={{ fontFamily: "'Lobster Two', cursive" }}>
          Terrible Butler
        </h1>
        <input
          data-testid="login-username-input"
          name="username"
          type="text"
          placeholder="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full p-2 rounded border border-rimmy-border bg-rimmy-black text-rimmy-text"
        />
        <input
          data-testid="login-password-input"
          name="password"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 rounded border border-rimmy-border bg-rimmy-black text-rimmy-text"
        />
        <label className="flex items-center gap-2 text-sm text-rimmy-text">
          <input
            type="checkbox"
            data-testid="remember-device-checkbox"
            checked={rememberDeviceChecked}
            onChange={(e) => setRememberDeviceChecked(e.target.checked)}
          />
          Remember this device
        </label>
        {rememberDeviceChecked && (
          <input
            data-testid="device-label-input"
            type="text"
            placeholder="Device name (e.g. Kitchen tablet)"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            className="w-full p-2 rounded border border-rimmy-border bg-rimmy-black text-rimmy-text"
          />
        )}
        {error && (
          <p data-testid="login-error" className="text-sm text-red-500">
            {error}
          </p>
        )}
        <button
          type="submit"
          data-testid="login-submit-button"
          className="w-full bg-rimmy-orange hover:bg-rimmy-orangeHover text-white font-semibold p-2 rounded"
        >
          Log in
        </button>
      </form>
    </div>
  );
}
