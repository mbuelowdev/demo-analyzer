import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Popup, options page and background service worker. The content script is built separately as IIFE
// (content scripts can't be ES modules), see vite.content.config.ts.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  base: './',
  publicDir: resolve(import.meta.dirname, 'public'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup.html'),
        options: resolve(import.meta.dirname, 'src/options.html'),
        background: resolve(import.meta.dirname, 'src/background.ts'),
      },
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js', assetFileNames: 'assets/[name][extname]' },
    },
  },
});
