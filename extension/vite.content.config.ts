import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    target: 'chrome120',
    lib: { entry: resolve(import.meta.dirname, 'src/content.ts'), formats: ['iife'], name: 'demoAnalyzerContent', fileName: () => 'content.js' },
  },
});
