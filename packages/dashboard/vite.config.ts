import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shrkcrft/dashboard-api': resolve(__dirname, '../dashboard-api/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4569,
    strictPort: false,
    proxy: {
      '/api': 'http://127.0.0.1:4567',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
