import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built and served at / by server.js — the default front end. The legacy front end is
// served alongside it at /legacy.
export default defineConfig({
  base: '/',
  plugins: [react()],
});
