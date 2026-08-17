import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AUTH_USERNAME, AUTH_PASSWORD_HASH, JWT_SECRET } from './auth-fixtures.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const PORT = 2699;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;

async function waitForServer(url, timeoutMs = 30000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms: ${lastError?.message}`);
}

export default async function globalSetup() {
  const dbPath = path.join(os.tmpdir(), `butler-e2e-${crypto.randomBytes(8).toString('hex')}.db`);

  const child = spawn('node', ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(PORT),
      AUTH_USERNAME,
      AUTH_PASSWORD_HASH,
      JWT_SECRET,
      // Invoice-import's LLM classify fallback must never depend on a real network call in
      // tests — point it at an address that refuses the connection immediately so the
      // fallback's own error handling (a null suggestion, not a blocked import) is what
      // actually runs, fast.
      LLM_API_URL: 'http://127.0.0.1:1',
    },
    stdio: 'inherit',
  });

  process.env.E2E_SERVER_PID = String(child.pid);
  process.env.E2E_DB_PATH = dbPath;

  await waitForServer(HEALTH_URL);

  return dbPath;
}
