import path from 'node:path';
import { app } from 'electron';

/**
 * Resolve the data-unified directory.
 * In dev (cwd is repo root), use ./data-unified.
 * In a packaged build, look next to the app's resources path.
 */
export function getDataRoot(): string {
  if (!app.isPackaged) {
    return path.resolve(process.cwd(), 'data-unified');
  }
  return path.resolve(process.resourcesPath, '..', 'data-unified');
}
