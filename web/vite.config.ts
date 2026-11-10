/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the browser talks to Vite, which forwards API calls to the Node server.
    proxy: { '/api': 'http://localhost:4000' },
  },
  test: { environment: 'jsdom', setupFiles: ['tests/setup.ts'], globals: false },
});
