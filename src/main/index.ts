import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getImportConfig } from './importers/registry';
import {
  detectAltimeter,
  ensureOutputDirectory,
  listFlights,
  previewImport,
  readImportedDataset,
  saveImport,
  saveImportedDatasetAttributes,
  type SaveImportRequest
} from './importService';

const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR ?? null;
const THEME_IDS = ['default-dark', 'slate-light', 'forest-dark', 'amber-dark'] as const;
type ThemeId = (typeof THEME_IDS)[number];
const DEFAULT_THEME: ThemeId = 'default-dark';

function getConfigDirectory(): string {
  if (portableExecutableDir) return portableExecutableDir;
  if (!app.isPackaged) return app.getAppPath();
  return app.getPath('userData');
}

function findFlightDataUpwards(startDir: string, maxLevels = 5): string | null {
  let current = path.resolve(startDir);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(current, 'flight-data');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // candidate doesn't exist at this level
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function getDefaultOutputDirectory(): string {
  const base = getConfigDirectory();
  // Portable exe + dev: walk up looking for an existing flight-data/ so the
  // exe can sit in release/ (or anywhere inside a repo) and still locate it.
  if (portableExecutableDir || !app.isPackaged) {
    const found = findFlightDataUpwards(base);
    if (found) return found;
  }
  return path.join(base, 'flight-data');
}

function getConfigFilePath(): string {
  return path.join(getConfigDirectory(), 'config.json');
}

type AppConfig = {
  outputDirectory?: string;
  theme?: ThemeId;
};

function readConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(getConfigFilePath(), 'utf-8');
    const config = JSON.parse(raw) as AppConfig;
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

function writeConfig(config: AppConfig): void {
  const configFile = getConfigFilePath();
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write app config:', err);
  }
}

function normalizeTheme(value: unknown): ThemeId {
  if (typeof value === 'string' && THEME_IDS.includes(value as ThemeId)) {
    return value as ThemeId;
  }
  return DEFAULT_THEME;
}

function getPersistedOutputDirectory(config: AppConfig): string | null {
  const dir = config.outputDirectory;
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

const persistedConfig = readConfig();
let outputDirectory = getPersistedOutputDirectory(persistedConfig) ?? getDefaultOutputDirectory();
let currentTheme: ThemeId = normalizeTheme(persistedConfig.theme);

function persistOutputDirectory(dir: string): void {
  const config = readConfig();
  config.outputDirectory = dir;
  if (!config.theme) {
    config.theme = currentTheme;
  }
  writeConfig(config);
}

function persistTheme(theme: ThemeId): void {
  const config = readConfig();
  config.outputDirectory = outputDirectory;
  config.theme = theme;
  writeConfig(config);
}

function buildAppMenu(mainWindow: BrowserWindow) {
  const themeItems: Electron.MenuItemConstructorOptions[] = [
    { id: 'default-dark', label: 'Default Dark' },
    { id: 'slate-light', label: 'Slate Light' },
    { id: 'forest-dark', label: 'Forest Dark' },
    { id: 'amber-dark', label: 'Amber Dark' }
  ].map((item) => ({
    type: 'radio',
    label: item.label,
    checked: currentTheme === item.id,
    click: () => {
      currentTheme = item.id as ThemeId;
      persistTheme(currentTheme);
      mainWindow.webContents.send('theme:changed', currentTheme);
      buildAppMenu(mainWindow);
    }
  }));

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Import',
          accelerator: 'CmdOrCtrl+I',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: 'Import Files',
              properties: ['openFile', 'multiSelections']
            });

            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('menu:import', result.filePaths);
            }
          }
        },
        {
          label: 'Open Directory',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: 'Open Flight Data Directory',
              defaultPath: outputDirectory,
              properties: ['openDirectory']
            });

            if (!result.canceled && result.filePaths[0]) {
              outputDirectory = path.resolve(result.filePaths[0]);
              await ensureOutputDirectory(outputDirectory);
              persistOutputDirectory(outputDirectory);
              mainWindow.webContents.send('directory:changed', outputDirectory);
            }
          }
        }
      ]
    },
    {
      label: 'Theme',
      submenu: themeItems
    }
  ]);

  Menu.setApplicationMenu(menu);
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Rocket Flight Data',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }

  buildAppMenu(mainWindow);
}

ipcMain.handle('import:get-config', () => getImportConfig());
ipcMain.handle('import:get-output-directory', () => outputDirectory);
ipcMain.handle('theme:get', () => currentTheme);
ipcMain.handle('import:list-flights', () => listFlights(outputDirectory));
ipcMain.handle('import:detect-altimeter', (_event, filePaths: string[]) =>
  detectAltimeter(filePaths)
);
ipcMain.handle('dataset:read', (_event, datasetDirectory: string) =>
  readImportedDataset(outputDirectory, datasetDirectory)
);
ipcMain.handle(
  'dataset:save-attributes',
  (_event, request: { datasetDirectory: string; attributes: { key: string; value: string }[] }) =>
    saveImportedDatasetAttributes(outputDirectory, request.datasetDirectory, request.attributes)
);
ipcMain.handle(
  'import:preview',
  (_event, request: { altimeterId: string; filePaths: string[] }) =>
    previewImport(request.altimeterId, request.filePaths)
);
ipcMain.handle('import:save', (_event, request: SaveImportRequest) =>
  saveImport(outputDirectory, request)
);

app.whenReady().then(async () => {
  await ensureOutputDirectory(outputDirectory);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
