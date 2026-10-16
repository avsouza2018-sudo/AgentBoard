import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies to the API composition root, so the page talks to the same surface an
 * agent talks to — same routes, same token, same error codes. Nothing here re-implements a route.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
