import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
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
});
