const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flightApi", {
  listFlights: () => ipcRenderer.invoke("flights:list"),
  getOverview: (directory) => ipcRenderer.invoke("flights:get-overview", directory),
  loadAltimeter: (directory, altimeterId) => ipcRenderer.invoke("flights:load-altimeter", directory, altimeterId),
  scanDirectories: () => ipcRenderer.invoke("flights:scan-dirs"),
  runIndex: () => ipcRenderer.invoke("flights:run-index"),
  saveOverrides: (directory, patch) => ipcRenderer.invoke("flights:save-overrides", directory, patch),
  getAttributeSchema: () => ipcRenderer.invoke("flights:get-attribute-schema"),
});
