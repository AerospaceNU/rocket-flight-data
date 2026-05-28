import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const projectRoot = __dirname;

export default defineConfig({
  main: {
    build: {
      outDir: resolve(projectRoot, 'dist-electron/main')
    }
  },
  preload: {
    build: {
      outDir: resolve(projectRoot, 'dist-electron/preload')
    }
  },
  renderer: {
    root: resolve(projectRoot, 'src/renderer'),
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(projectRoot, 'src/renderer/src')
      }
    },
    build: {
      outDir: resolve(projectRoot, 'dist/renderer'),
      emptyOutDir: true
    }
  }
});
