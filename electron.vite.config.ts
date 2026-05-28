import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist-electron/main'
    }
  },
  preload: {
    build: {
      outDir: 'dist-electron/preload'
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      outDir: '../../dist/renderer'
    }
  }
});
