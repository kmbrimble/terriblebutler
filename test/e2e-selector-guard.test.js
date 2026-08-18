import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Guards the contract from CHANGELOG.md's "data-testid contract for the e2e suite" entry:
// test-e2e/ must stay decoupled from public/index.html's implementation details so the same
// suite can be pointed at a future React front end.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.join(__dirname, '..', 'test-e2e');
const specFiles = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.js'));

const testidExports = (fs.readFileSync(path.join(E2E_DIR, 'testids.js'), 'utf8').match(/export const (\w+)/g) || [])
  .map((m) => m.replace('export const ', ''));

describe('e2e selector guard', () => {
  for (const file of specFiles) {
    const content = fs.readFileSync(path.join(E2E_DIR, file), 'utf8');

    test(`${file} does not use an onclick attribute selector`, () => {
      expect(content).not.toMatch(/\[onclick\s*=/);
    });

    test(`${file} does not use a raw #id or .class CSS selector`, () => {
      const violations =
        content.match(/\.(?:locator|fill|click|dblclick|selectOption|textContent)\(\s*[`'"][.#]/g) || [];
      expect(violations).toEqual([]);
    });

    test(`${file} only uses testids exported from test-e2e/testids.js`, () => {
      const used = [...content.matchAll(/getByTestId\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)].map((m) => m[1]);
      const unknown = used.filter((id) => !testidExports.includes(id));
      expect(unknown).toEqual([]);
    });
  }
});
