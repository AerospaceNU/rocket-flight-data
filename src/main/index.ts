import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { getDataRoot } from './paths';
import { readAttributes, writeAttributes, readData } from './tsv';
import type { AltimeterSummary, AttributeRow, FlightSummary } from '../shared/types';

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function parseFlightFolder(name: string): { date: string | null; name: string } {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(name);
  if (m) return { date: m[1], name: m[2] };
  return { date: null, name };
}

function getAttrMap(rows: AttributeRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.key, r.value);
  return m;
}

function flightDir(flightId: string): string {
  return path.join(getDataRoot(), flightId);
}

function altimeterDir(flightId: string, altimeterId: string): string {
  return path.join(getDataRoot(), flightId, altimeterId);
}

ipcMain.handle('flights:list', (): FlightSummary[] => {
  const root = getDataRoot();
  const folders = safeReaddir(root);
  folders.sort();
  return folders.map((id) => {
    const parsed = parseFlightFolder(id);
    return { id, ...parsed };
  });
});

ipcMain.handle('altimeters:list', (_evt, flightId: string): AltimeterSummary[] => {
  const folders = safeReaddir(flightDir(flightId));
  folders.sort();
  return folders.map((id) => {
    const attrPath = path.join(altimeterDir(flightId, id), 'attributes.tsv');
    const attrs = readAttributes(attrPath);
    const board = getAttrMap(attrs).get('altimeter.board') ?? 'Unknown';
    return { id, flightId, board };
  });
});

ipcMain.handle('attributes:get', (_evt, flightId: string, altimeterId: string): AttributeRow[] => {
  return readAttributes(path.join(altimeterDir(flightId, altimeterId), 'attributes.tsv'));
});

ipcMain.handle(
  'attributes:save',
  (_evt, flightId: string, altimeterId: string, rows: AttributeRow[]) => {
    try {
      writeAttributes(path.join(altimeterDir(flightId, altimeterId), 'attributes.tsv'), rows);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
);

ipcMain.handle('data:get', (_evt, flightId: string, altimeterId: string) => {
  const dir = altimeterDir(flightId, altimeterId);
  const attrs = readAttributes(path.join(dir, 'attributes.tsv'));
  const timeColumn = getAttrMap(attrs).get('data.time_column') ?? null;
  return readData(path.join(dir, 'data.tsv'), timeColumn);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist-renderer', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
