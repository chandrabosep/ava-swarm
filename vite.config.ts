import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'node:path';
import manifest from './manifest.config';

// New-tab override extensions are static-page extensions, so the standard
// Vite build is sufficient. We use @crxjs/vite-plugin to keep the manifest
// in sync with the build output and to handle dev-time HMR.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Required by @crxjs/vite-plugin for stable HMR sockets in MV3
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      // Force a deterministic output structure — the manifest's newtab override
      // points at index.html, which crxjs wires up automatically.
      output: {},
    },
  },
});
