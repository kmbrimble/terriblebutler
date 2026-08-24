import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Built and served at / by server.js — the default front end. The legacy front end is
// served alongside it at /legacy.
//
// Multi-page build for issue #37's alternate-style variants: each entry in public/variants.json
// gets its own <slug>.html build input (only for slugs that already have an HTML file — a
// variant listed in variants.json before its html/component tree exists shouldn't break the
// build). Vite emits every entry flat into dist/ alongside index.html, which server.js already
// serves as-is (see server.js's express.static('client/dist') comment).
const root = path.dirname(fileURLToPath(import.meta.url));
const variants = JSON.parse(readFileSync(path.join(root, 'public/variants.json'), 'utf8')) as {
  slug: string;
}[];

const input: Record<string, string> = { main: path.join(root, 'index.html') };
for (const { slug } of variants) {
  const htmlPath = path.join(root, `${slug}.html`);
  if (existsSync(htmlPath)) input[slug] = htmlPath;
}

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    rollupOptions: { input },
  },
});
