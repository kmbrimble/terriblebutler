import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const PORT = 2699;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/locations`;

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
    },
    stdio: 'inherit',
  });

  process.env.E2E_SERVER_PID = String(child.pid);
  process.env.E2E_DB_PATH = dbPath;

  await waitForServer(HEALTH_URL);

  return dbPath;
}
