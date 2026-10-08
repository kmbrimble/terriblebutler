import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import './setup.js';
import pkg from '../server.js';

const { app } = pkg;
const dist = path.join(__dirname, '..', 'client', 'dist');

function directives(header) {
  return Object.fromEntries(
    header.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values])
  );
}

describe('Content-Security-Policy', () => {
  for (const url of ['/healthz', '/api/health', '/api/locations', '/nonexistent-client-route']) {
    it(`is sent on ${url}`, async () => {
      const res = await request(app).get(url);
      expect(res.headers['content-security-policy']).toBeDefined();
    });
  }

  it('locks down scripts, plugins, base URI, framing and form targets', async () => {
    const res = await request(app).get('/healthz');
    const csp = directives(res.headers['content-security-policy']);

    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    for (const [name, values] of Object.entries(csp)) {
      if (name === 'style-src') continue;
      expect(values, name).not.toContain("'unsafe-inline'");
    }
    for (const values of Object.values(csp)) expect(values).not.toContain("'unsafe-eval'");
  });

  it('allows what the camera, crop and scanner flows need, and nothing third-party', async () => {
    const res = await request(app).get('/healthz');
    const csp = directives(res.headers['content-security-policy']);

    expect(csp['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
    expect(csp['media-src']).toEqual(expect.arrayContaining(["'self'", 'blob:']));
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(res.headers['content-security-policy']).not.toMatch(/https?:\/\//);
  });

  it('keeps camera allowed in Permissions-Policy alongside the CSP', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
  });

  // The built pages must stay compatible with script-src 'self': no inline scripts, no
  // third-party origins. Skipped when the client has not been built (npm run build:client).
  const built = fs.existsSync(dist);
  it.skipIf(!built)('built HTML pages have no inline scripts or third-party loads', () => {
    const pages = fs.readdirSync(dist).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const html = fs.readFileSync(path.join(dist, page), 'utf8');
      for (const m of html.matchAll(/<script\b([^>]*)>/g)) expect(m[1], page).toMatch(/\bsrc=/);
      expect(html, page).not.toMatch(/\bon\w+\s*=/i);
      expect(html, page).not.toMatch(/(?:src|href)=["']https?:/i);
    }
  });
});
