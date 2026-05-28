import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
const REMOTE_FLIGHT_DATA_REPO = 'https://github.com/AerospaceNU/rocket-flight-data.git';
const REMOTE_FLIGHT_DATA_BRANCH = 'new-app-dev';
const REMOTE_FLIGHT_DATA_SUBDIR = 'flight-data';

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

function runGitCommand(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true
    });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

function resolveFlightDataDownloadTarget(selectedDirectory: string): string {
  const resolved = path.resolve(selectedDirectory);
  return path.basename(resolved).toLowerCase() === 'flight-data'
    ? resolved
    : path.join(resolved, 'flight-data');
}

async function downloadRemoteFlightData(mainWindow: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Location for Downloaded Flight Data',
    defaultPath: path.dirname(outputDirectory),
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths[0]) {
    return;
  }

  const targetDirectory = resolveFlightDataDownloadTarget(result.filePaths[0]);

  if (fs.existsSync(targetDirectory)) {
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Replace existing data in:\n${targetDirectory}?`,
      detail: 'This will remove the existing folder before downloading the latest data.'
    });

    if (confirm.response !== 0) {
      return;
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rocket-flight-data-sync-'));
  const cloneDirectory = path.join(tempRoot, 'repo');

  try {
    await runGitCommand(
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        REMOTE_FLIGHT_DATA_BRANCH,
        '--filter=blob:none',
        '--sparse',
        REMOTE_FLIGHT_DATA_REPO,
        cloneDirectory
      ],
      undefined
    );
    await runGitCommand(['sparse-checkout', 'set', REMOTE_FLIGHT_DATA_SUBDIR], cloneDirectory);

    const sourceDirectory = path.join(cloneDirectory, REMOTE_FLIGHT_DATA_SUBDIR);
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
      throw new Error(`Remote folder not found: ${REMOTE_FLIGHT_DATA_SUBDIR}`);
    }

    fs.rmSync(targetDirectory, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDirectory), { recursive: true });
    fs.cpSync(sourceDirectory, targetDirectory, { recursive: true, force: true });

    outputDirectory = targetDirectory;
    await ensureOutputDirectory(outputDirectory);
    persistOutputDirectory(outputDirectory);
    mainWindow.webContents.send('directory:changed', outputDirectory);

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['OK'],
      message: 'Flight data downloaded.',
      detail: `Downloaded ${REMOTE_FLIGHT_DATA_SUBDIR} from ${REMOTE_FLIGHT_DATA_BRANCH} and set it as the active directory.\n\n${outputDirectory}`
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred while downloading flight data.';
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      buttons: ['OK'],
      message: 'Download failed.',
      detail: message
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
    },
    {
      label: 'Download',
      submenu: [
        {
          label: 'Sync Flight Data From GitHub',
          click: () => {
            void downloadRemoteFlightData(mainWindow);
          }
        }
      ]
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
