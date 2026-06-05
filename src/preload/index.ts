import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('appInfo', {
  name: 'Rocket Flight Data',
  version: '0.1.0'
});

contextBridge.exposeInMainWorld('appBridge', {
  getImportConfig: () => ipcRenderer.invoke('import:get-config'),
  getOutputDirectory: () => ipcRenderer.invoke('import:get-output-directory'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  listFlights: () => ipcRenderer.invoke('import:list-flights'),
  previewGitDataSubmit: () => ipcRenderer.invoke('git-data:preview-submit'),
  submitGitDataChanges: (request: unknown) => ipcRenderer.invoke('git-data:submit', request),
  detectAltimeter: (filePaths: string[]) => ipcRenderer.invoke('import:detect-altimeter', filePaths),
  readDataset: (datasetDirectory: string, options?: { sanitize?: boolean }) =>
    ipcRenderer.invoke('dataset:read', datasetDirectory, options),
  saveDatasetAttributes: (request: unknown) =>
    ipcRenderer.invoke('dataset:save-attributes', request),
  readFlightAttributes: (flightDirectoryName: string) =>
    ipcRenderer.invoke('flight:read-attributes', flightDirectoryName),
  saveFlightAttributes: (request: unknown) =>
    ipcRenderer.invoke('flight:save-attributes', request),
  previewImport: (request: { altimeterId: string; filePaths: string[] }) =>
    ipcRenderer.invoke('import:preview', request),
  saveImport: (request: unknown) => ipcRenderer.invoke('import:save', request),
  debugLog: (message: string, data?: unknown) => ipcRenderer.invoke('debug:log', { message, data }),
  onImportRequested: (callback: (paths: string[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, paths: string[]) => callback(paths);
    ipcRenderer.on('menu:import', listener);
    return () => {
      ipcRenderer.removeListener('menu:import', listener);
    };
  },
  onSubmitDataRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:submit-data', listener);
    return () => {
      ipcRenderer.removeListener('menu:submit-data', listener);
    };
  },
  onOutputDirectoryChanged: (callback: (path: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, outputDirectory: string) =>
      callback(outputDirectory);
    ipcRenderer.on('directory:changed', listener);
    return () => {
      ipcRenderer.removeListener('directory:changed', listener);
    };
  },
  onThemeChanged: (callback: (theme: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: string) => callback(theme);
    ipcRenderer.on('theme:changed', listener);
    return () => {
      ipcRenderer.removeListener('theme:changed', listener);
    };
  }
});
