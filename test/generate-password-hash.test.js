import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import bcrypt from 'bcryptjs';
import path from 'path';

const scriptPath = path.join(process.cwd(), 'scripts', 'generate-password-hash.js');

describe('scripts/generate-password-hash.js', () => {
  it('prints a bcrypt hash that verifies against the given password', () => {
    const output = execFileSync('node', [scriptPath, 'correct-horse-battery-staple']).toString().trim();
    expect(bcrypt.compareSync('correct-horse-battery-staple', output)).toBe(true);
    expect(bcrypt.compareSync('wrong-password', output)).toBe(false);
  });

  it('exits non-zero with a usage message when no password is given', () => {
    expect(() => execFileSync('node', [scriptPath])).toThrow();
  });

  describe('bcrypt only reads the first 72 bytes of a password', () => {
    const run = (password) => spawnSync('node', [scriptPath, password], { encoding: 'utf8' });

    it('accepts exactly 72 bytes', () => {
      const result = run('p'.repeat(72));
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\$2[aby]\$10\$/);
    });

    it('refuses 73 bytes with a clear message and prints no hash', () => {
      const result = run('p'.repeat(73));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/73 bytes.*first 72/);
    });

    it('counts UTF-8 bytes, not characters', () => {
      expect(run('€'.repeat(24)).status).toBe(0); // 72 bytes
      const over = run('€'.repeat(25)); // 25 characters, 75 bytes
      expect(over.status).toBe(1);
      expect(over.stderr).toMatch(/75 bytes/);
    });

    it('does not echo the password', () => {
      expect(run('secret-sentinel-'.repeat(6)).stderr).not.toContain('secret-sentinel');
    });
  });
});
