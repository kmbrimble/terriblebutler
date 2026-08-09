import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { afterAll } from 'vitest';

const tmpDbPath = path.join(os.tmpdir(), `butler-test-${crypto.randomBytes(8).toString('hex')}.db`);
process.env.DB_PATH = tmpDbPath;

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    const file = tmpDbPath + suffix;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
});
