import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
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

let outputDirectory = path.join(process.cwd(), 'flight-data');

function buildAppMenu(mainWindow: BrowserWindow) {
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
              outputDirectory = result.filePaths[0];
              await ensureOutputDirectory(outputDirectory);
              mainWindow.webContents.send('directory:changed', outputDirectory);
            }
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
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  buildAppMenu(mainWindow);
}

ipcMain.handle('import:get-config', () => getImportConfig());
ipcMain.handle('import:get-output-directory', () => outputDirectory);
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
