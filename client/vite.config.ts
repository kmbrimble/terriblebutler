import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built and served at /v2 by server.js, alongside the legacy front end at /.
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
});
