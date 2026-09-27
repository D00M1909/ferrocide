import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
});
