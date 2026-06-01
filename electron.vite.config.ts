import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const projectRoot = __dirname;

export default defineConfig({
  main: {
    // Keep node dependencies (e.g. electron-updater, which does dynamic requires
    // and resolves app-update.yml at runtime) external so they load from
    // node_modules in the packaged app instead of being bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(projectRoot, 'dist-electron/main')
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
