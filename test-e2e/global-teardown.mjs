import fs from 'node:fs';

export default async function globalTeardown() {
  const pid = process.env.E2E_SERVER_PID;
  if (pid) {
    try {
      process.kill(Number(pid));
    } catch (err) {
      // process may have already exited
    }
  }

  const dbPath = process.env.E2E_DB_PATH;
  if (dbPath) {
    for (const suffix of ['', '-shm', '-wal']) {
      const file = dbPath + suffix;
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  }
}
