// Plain TypeScript, no React or DOM-library imports — this is the layer the eventual React
// Native app reuses. Only ambient Web-standard globals (fetch, localStorage) are used, which
// have React Native equivalents/polyfills.

const TOKEN_KEY = 'tb_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Login failed.');
  }
  localStorage.setItem(TOKEN_KEY, data.token);
}
