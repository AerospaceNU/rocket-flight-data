const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const {
  getDataRoot,
  listFlightDirectories,
  readAllOverviews,
  parseAltimeterForViewer,
  runIndexer,
  saveOverridesAndRebuildFlight,
  getFlightAttributeSchema,
} = require("./lib/flight-data");

const repoRoot = __dirname;
const dataRoot = getDataRoot(repoRoot);

function resolveSafePath(...parts) {
  const resolved = path.resolve(dataRoot, ...parts);
  if (!resolved.startsWith(path.resolve(dataRoot))) {
    throw new Error("Invalid path outside data root");
  }
  return resolved;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
}

function compactOverview(overview) {
  return {
    directory: overview.directory,
    date: overview.date,
    year: overview.year,
    rocketName: overview.rocketName,
    stats: overview.stats,
    filters: overview.filters,
    flightNotes: overview.flightNotes || "",
    altimeterCount: Array.isArray(overview.altimeters) ? overview.altimeters.length : 0,
  };
}

ipcMain.handle("flights:list", async () => {
  const overviews = readAllOverviews(dataRoot);
  return {
    hasIndex: overviews.length > 0,
    flights: overviews.map(compactOverview),
  };
});

ipcMain.handle("flights:get-overview", async (_event, directory) => {
  if (!directory || typeof directory !== "string") throw new Error("Directory is required");
  const overviewPath = resolveSafePath(directory, ".flight-overview.json");
  if (!fs.existsSync(overviewPath)) throw new Error("Overview file does not exist. Run npm run index-data first.");
  const overview = JSON.parse(fs.readFileSync(overviewPath, "utf8"));
  return overview;
});

ipcMain.handle("flights:load-altimeter", async (_event, directory, altimeterId) => {
  if (!directory || typeof directory !== "string") throw new Error("Directory is required");
  if (!altimeterId || typeof altimeterId !== "string") throw new Error("Altimeter id is required");
  const flightPath = resolveSafePath(directory);
  return parseAltimeterForViewer(flightPath, altimeterId);
});

ipcMain.handle("flights:scan-dirs", async () => {
  const dirs = listFlightDirectories(dataRoot).map((entry) => entry.name);
  return {
    totalDirectories: dirs.length,
    directories: dirs,
  };
});

ipcMain.handle("flights:run-index", async () => {
  const result = runIndexer(dataRoot);
  return {
    ...result,
    flights: readAllOverviews(dataRoot).map(compactOverview),
  };
});

ipcMain.handle("flights:save-overrides", async (_event, directory, patch) => {
  if (!directory || typeof directory !== "string") throw new Error("Directory is required");
  if (!patch || typeof patch !== "object") throw new Error("Override patch is required");
  return saveOverridesAndRebuildFlight(dataRoot, directory, patch);
});

ipcMain.handle("flights:get-attribute-schema", async () => {
  return getFlightAttributeSchema();
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
