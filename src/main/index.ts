import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import updaterPkg from 'electron-updater';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getImportConfig } from './importers/registry';
import {
  initLogger,
  logMain,
  logMainError,
  logRenderer
} from './logger';
import {
  APP_CLASS,
  APP_ID,
  APP_NAME,
  ensureLinuxAppImageIntegration,
  getBundledIconPath
} from './linuxAppImage';
import {
  detectAltimeter,
  ensureOutputDirectory,
  listFlights,
  previewImport,
  readFlightAttributes,
  readImportedDataset,
  saveFlightAttributes,
  saveImport,
  saveImportedDatasetAttributes,
  type SaveImportRequest
} from './importService';

const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR ?? null;
const THEME_IDS = ['default-dark', 'slate-light', 'forest-dark', 'amber-dark'] as const;
type ThemeId = (typeof THEME_IDS)[number];
const DEFAULT_THEME: ThemeId = 'default-dark';
const REMOTE_FLIGHT_DATA_REPO = 'https://github.com/AerospaceNU/rocket-flight-data.git';
const REMOTE_FLIGHT_DATA_BRANCH = 'main';
const REMOTE_FLIGHT_DATA_SUBDIR = 'flight-data';
const MANAGED_REPOSITORY_DIRECTORY_NAME = 'repo';
const REPOSITORY_DIRECTORY_NAME = 'rocket-flight-data';
const THEME_BACKGROUND_COLORS: Record<ThemeId, string> = {
  'default-dark': '#111315',
  'slate-light': '#edf1f5',
  'forest-dark': '#0f1613',
  'amber-dark': '#17120d'
};

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', APP_CLASS);
  app.commandLine.appendSwitch('no-sandbox');
}

function getSessionDataDirectory() {
  if (portableExecutableDir) {
    return path.join(portableExecutableDir, 'session-data');
  }

  const cacheRoot = process.env.LOCALAPPDATA ?? os.tmpdir();
  return path.join(cacheRoot, 'rocket-flight-data', 'session-data');
}

function configureChromiumCacheDirectory() {
  const sessionDataDirectory = getSessionDataDirectory();
  const cacheDirectory = path.join(sessionDataDirectory, 'Cache');

  try {
    fs.mkdirSync(sessionDataDirectory, { recursive: true });
    fs.mkdirSync(cacheDirectory, { recursive: true });
    app.setPath('sessionData', sessionDataDirectory);
    app.commandLine.appendSwitch('disk-cache-dir', cacheDirectory);
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  } catch (error) {
    console.error('Failed to configure Chromium cache directory:', error);
  }
}

configureChromiumCacheDirectory();

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
  // Dev: use the source checkout. Packaged/portable: use the app-managed repo.
  if (!app.isPackaged) {
    const found = findFlightDataUpwards(base);
    if (found) return found;
  }
  return path.join(getManagedRepositoryDirectory(), REMOTE_FLIGHT_DATA_SUBDIR);
}

function getManagedRepositoryDirectory(): string {
  return path.join(getConfigDirectory(), MANAGED_REPOSITORY_DIRECTORY_NAME);
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

function themeBackgroundColor(theme: ThemeId) {
  return THEME_BACKGROUND_COLORS[theme] ?? THEME_BACKGROUND_COLORS[DEFAULT_THEME];
}

function getPersistedOutputDirectory(config: AppConfig): string | null {
  const dir = config.outputDirectory;
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

const persistedConfig = readConfig();
let outputDirectory = getPersistedOutputDirectory(persistedConfig) ?? getDefaultOutputDirectory();
let currentTheme: ThemeId = normalizeTheme(persistedConfig.theme);

initLogger(getConfigDirectory());
logMain('app bootstrap', {
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  outputDirectory
});

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

async function runLogged<T>(
  operation: string,
  metadata: Record<string, unknown>,
  work: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  logMain(`${operation}:start`, metadata);
  try {
    const result = await work();
    logMain(`${operation}:ok`, { ...metadata, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    logMainError(`${operation}:error`, error, {
      ...metadata,
      durationMs: Date.now() - started
    });
    throw error;
  }
}

type GitCommandResult = {
  stdout: string;
  stderr: string;
};

type GitDataChange = {
  path: string;
  status: string;
};

type GitDataSubmitPreview = {
  repositoryRoot: string;
  dataDirectory: string;
  dataPath: string;
  currentBranch: string;
  baseBranch: string;
  remoteName: string;
  remoteUrl: string;
  gitVersion: string;
  credentialManagerVersion: string | null;
  changes: GitDataChange[];
  warnings: string[];
};

type SubmitGitDataRequest = {
  selectedPaths: string[];
  commitMessage: string;
};

type SubmitGitDataResult = {
  branchName: string;
  commitSha: string;
  pullRequestUrl: string | null;
};

function getBundledGitExecutable(): string | null {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'bundled-git', 'cmd', 'git.exe'),
        path.join(process.resourcesPath, 'bundled-git', 'bin', 'git.exe')
      ]
    : [
        path.join(app.getAppPath(), 'build', 'bundled-git', 'cmd', 'git.exe'),
        path.join(app.getAppPath(), 'build', 'bundled-git', 'bin', 'git.exe')
      ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getGitExecutable(): string {
  return getBundledGitExecutable() ?? 'git';
}

function gitEnvironment(gitExecutable: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const gitRoot =
    path.basename(path.dirname(gitExecutable)).toLowerCase() === 'cmd'
      ? path.dirname(path.dirname(gitExecutable))
      : null;

  if (gitRoot) {
    env.PATH = [
      path.join(gitRoot, 'cmd'),
      path.join(gitRoot, 'mingw64', 'bin'),
      path.join(gitRoot, 'usr', 'bin'),
      env.PATH
    ].filter(Boolean).join(path.delimiter);
  }

  return env;
}

function runGitCommand(args: string[], cwd?: string): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const gitExecutable = getGitExecutable();
    logMain('git:start', { args, cwd, bundled: gitExecutable !== 'git' });
    const child = spawn(gitExecutable, args, {
      cwd,
      windowsHide: true,
      env: gitEnvironment(gitExecutable)
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        logMain('git:ok', { args, cwd });
        resolve({ stdout, stderr });
        return;
      }
      logMain('git:fail', { args, cwd, code, stderr: stderr.trim() });
      reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

function normalizeGitPath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseGitStatus(output: string): GitDataChange[] {
  const entries = output.split('\0').filter(Boolean);
  const changes: GitDataChange[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;

    const status = entry.slice(0, 2).trim() || 'modified';
    changes.push({
      status,
      path: normalizeGitPath(entry.slice(3))
    });

    // Rename/copy records include the previous path as a second NUL-delimited
    // field. The new path above is the path the user can commit.
    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
  }

  return changes;
}

async function isSourceFingerprintOnlyChange(repositoryRoot: string, change: GitDataChange) {
  if (!change.path.endsWith('/attributes.csv') || change.status.includes('?') || change.status.includes('A')) {
    return false;
  }

  const [unstagedDiff, stagedDiff] = await Promise.all([
    runGitCommand(['diff', '--unified=0', '--', change.path], repositoryRoot),
    runGitCommand(['diff', '--cached', '--unified=0', '--', change.path], repositoryRoot)
  ]);
  const changedLines = `${unstagedDiff.stdout}\n${stagedDiff.stdout}`
    .split(/\r?\n/)
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---')
    );

  return (
    changedLines.length > 0 &&
    changedLines.every((line) => line.slice(1).startsWith('source_fingerprint,'))
  );
}

async function resolveDataRepository() {
  const root = (await runGitCommand(['rev-parse', '--show-toplevel'], outputDirectory)).stdout.trim();
  const repositoryRoot = path.resolve(root);
  const dataDirectory = path.resolve(outputDirectory);
  const dataPath = normalizeGitPath(path.relative(repositoryRoot, dataDirectory));

  if (!dataPath || dataPath.startsWith('..') || path.isAbsolute(dataPath)) {
    throw new Error('The active flight data directory is not inside a Git repository.');
  }

  if (dataPath !== REMOTE_FLIGHT_DATA_SUBDIR) {
    throw new Error(`The active data directory must be the repository's ${REMOTE_FLIGHT_DATA_SUBDIR} folder.`);
  }

  return { repositoryRoot, dataDirectory, dataPath };
}

async function gitCredentialManagerVersion(repositoryRoot: string) {
  try {
    const result = await runGitCommand(['credential-manager', '--version'], repositoryRoot);
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

function githubCompareUrl(remoteUrl: string, baseBranch: string, branchName: string) {
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  const match = httpsMatch ?? sshMatch;
  if (!match) return null;

  return `https://github.com/${match[1]}/${match[2]}/compare/${baseBranch}...${branchName}?expand=1`;
}

function validateSelectedGitDataPaths(pathsToValidate: string[], dataPath: string) {
  const normalizedDataPath = `${normalizeGitPath(dataPath)}/`;
  const normalized = pathsToValidate.map(normalizeGitPath);

  for (const selectedPath of normalized) {
    if (!selectedPath.startsWith(normalizedDataPath)) {
      throw new Error(`Refusing to submit a file outside ${dataPath}: ${selectedPath}`);
    }
  }

  return normalized;
}

function dataBranchName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `data/${stamp}`;
}

export async function previewGitDataSubmit(): Promise<GitDataSubmitPreview> {
  const { repositoryRoot, dataDirectory, dataPath } = await resolveDataRepository();
  const [gitVersion, currentBranch, remoteUrl, status] = await Promise.all([
    runGitCommand(['--version'], repositoryRoot),
    runGitCommand(['branch', '--show-current'], repositoryRoot),
    runGitCommand(['remote', 'get-url', 'origin'], repositoryRoot),
    runGitCommand(['status', '--porcelain=v1', '-z', '--', dataPath], repositoryRoot)
  ]);
  const credentialManagerVersion = await gitCredentialManagerVersion(repositoryRoot);
  const warnings: string[] = [];
  const rawChanges = parseGitStatus(status.stdout);
  const sourceFingerprintOnlyFlags = await Promise.all(
    rawChanges.map((change) => isSourceFingerprintOnlyChange(repositoryRoot, change))
  );
  const ignoredSourceFingerprintOnlyCount = sourceFingerprintOnlyFlags.filter(Boolean).length;

  if (!credentialManagerVersion) {
    warnings.push('Git Credential Manager was not detected. GitHub may prompt for authentication outside the app.');
  }
  if (ignoredSourceFingerprintOnlyCount > 0) {
    warnings.push(
      `Ignored ${ignoredSourceFingerprintOnlyCount} source_fingerprint-only attribute change(s).`
    );
  }

  return {
    repositoryRoot,
    dataDirectory,
    dataPath,
    currentBranch: currentBranch.stdout.trim() || '(detached)',
    baseBranch: REMOTE_FLIGHT_DATA_BRANCH,
    remoteName: 'origin',
    remoteUrl: remoteUrl.stdout.trim(),
    gitVersion: gitVersion.stdout.trim(),
    credentialManagerVersion,
    changes: rawChanges.filter((_change, index) => !sourceFingerprintOnlyFlags[index]),
    warnings
  };
}

export async function submitGitDataChanges(request: SubmitGitDataRequest): Promise<SubmitGitDataResult> {
  const preview = await previewGitDataSubmit();
  const selectedPaths = validateSelectedGitDataPaths(request.selectedPaths, preview.dataPath);
  const message = request.commitMessage.trim();

  if (selectedPaths.length === 0) {
    throw new Error('Select at least one flight-data file to submit.');
  }
  if (!message) {
    throw new Error('Enter a commit message.');
  }

  await runGitCommand(['fetch', preview.remoteName, preview.baseBranch], preview.repositoryRoot);
  const branchName = dataBranchName();
  await runGitCommand(['switch', '-c', branchName], preview.repositoryRoot);
  await runGitCommand(['add', '--', ...selectedPaths], preview.repositoryRoot);
  await runGitCommand(['commit', '-m', message, '--', ...selectedPaths], preview.repositoryRoot);
  const commitSha = (await runGitCommand(['rev-parse', 'HEAD'], preview.repositoryRoot)).stdout.trim();
  await runGitCommand(['push', '-u', preview.remoteName, branchName], preview.repositoryRoot);

  const pullRequestUrl = githubCompareUrl(preview.remoteUrl, preview.baseBranch, branchName);
  if (pullRequestUrl) {
    await shell.openExternal(pullRequestUrl);
  }

  return { branchName, commitSha, pullRequestUrl };
}

function resolveRepositoryDownloadTarget(selectedDirectory: string): string {
  const resolved = path.resolve(selectedDirectory);
  return path.basename(resolved).toLowerCase() === REPOSITORY_DIRECTORY_NAME
    ? resolved
    : path.join(resolved, REPOSITORY_DIRECTORY_NAME);
}

function isGitRepository(directory: string) {
  return fs.existsSync(path.join(directory, '.git'));
}

function isEmptyDirectory(directory: string) {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return true;
  }
}

function isEmptyPlaceholderRepositoryDirectory(directory: string) {
  try {
    const entries = fs.readdirSync(directory);
    if (entries.length === 0) return true;
    if (entries.length !== 1 || entries[0] !== REMOTE_FLIGHT_DATA_SUBDIR) return false;
    return isEmptyDirectory(path.join(directory, REMOTE_FLIGHT_DATA_SUBDIR));
  } catch {
    return true;
  }
}

function flightDataDirectoryForRepository(repositoryDirectory: string) {
  return path.join(repositoryDirectory, REMOTE_FLIGHT_DATA_SUBDIR);
}

async function setActiveRepository(mainWindow: BrowserWindow, repositoryDirectory: string) {
  outputDirectory = flightDataDirectoryForRepository(repositoryDirectory);
  await ensureOutputDirectory(outputDirectory);
  persistOutputDirectory(outputDirectory);
  mainWindow.webContents.send('directory:changed', outputDirectory);
}

// Default download/sync: maintain a full app-managed checkout, then point the
// app at its flight-data subdirectory.
async function downloadRemoteFlightData(mainWindow: BrowserWindow): Promise<void> {
  await syncRemoteFlightData(mainWindow, getManagedRepositoryDirectory());
}

// Optional download: lets the user pick where the full repository checkout goes.
async function downloadRemoteFlightDataToChosenLocation(mainWindow: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Location for Repository Checkout',
    defaultPath: path.dirname(path.dirname(outputDirectory)),
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths[0]) {
    return;
  }

  await syncRemoteFlightData(mainWindow, resolveRepositoryDownloadTarget(result.filePaths[0]));
}

async function syncExistingRepository(mainWindow: BrowserWindow, repositoryDirectory: string) {
  const currentBranch = (await runGitCommand(['branch', '--show-current'], repositoryDirectory)).stdout.trim();

  if (currentBranch && currentBranch !== REMOTE_FLIGHT_DATA_BRANCH) {
    const pendingChanges = (await runGitCommand(['status', '--porcelain=v1'], repositoryDirectory)).stdout.trim();
    if (pendingChanges) {
      throw new Error(
        `Repository is on ${currentBranch} with uncommitted changes. Submit or discard those changes before syncing ${REMOTE_FLIGHT_DATA_BRANCH}.`
      );
    }

    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [`Switch to ${REMOTE_FLIGHT_DATA_BRANCH}`, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Switch repository from ${currentBranch} to ${REMOTE_FLIGHT_DATA_BRANCH}?`,
      detail:
        'Submitted but unmerged data may stop appearing locally until the pull request is merged into main.'
    });

    if (confirm.response !== 0) {
      return false;
    }

    await runGitCommand(['switch', REMOTE_FLIGHT_DATA_BRANCH], repositoryDirectory);
  }

  await runGitCommand(['fetch', 'origin', REMOTE_FLIGHT_DATA_BRANCH], repositoryDirectory);
  await runGitCommand(['pull', '--ff-only', 'origin', REMOTE_FLIGHT_DATA_BRANCH], repositoryDirectory);
  await setActiveRepository(mainWindow, repositoryDirectory);
  return true;
}

async function cloneRemoteRepository(mainWindow: BrowserWindow, repositoryDirectory: string) {
  if (fs.existsSync(repositoryDirectory) && !isEmptyPlaceholderRepositoryDirectory(repositoryDirectory)) {
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Replace existing folder with a fresh repository clone?\n${repositoryDirectory}`,
      detail: 'This removes that folder before cloning. Existing Git repositories are updated instead of replaced.'
    });

    if (confirm.response !== 0) {
      return false;
    }

    fs.rmSync(repositoryDirectory, { recursive: true, force: true });
  } else if (fs.existsSync(repositoryDirectory)) {
    fs.rmSync(repositoryDirectory, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(repositoryDirectory), { recursive: true });
  await runGitCommand(
    [
      'clone',
      '--branch',
      REMOTE_FLIGHT_DATA_BRANCH,
      REMOTE_FLIGHT_DATA_REPO,
      repositoryDirectory
    ],
    undefined
  );

  if (!fs.existsSync(flightDataDirectoryForRepository(repositoryDirectory))) {
    throw new Error(`Remote folder not found: ${REMOTE_FLIGHT_DATA_SUBDIR}`);
  }

  await setActiveRepository(mainWindow, repositoryDirectory);
  return true;
}

async function syncRemoteFlightData(mainWindow: BrowserWindow, repositoryDirectory: string): Promise<void> {
  try {
    const didSync = isGitRepository(repositoryDirectory)
      ? await syncExistingRepository(mainWindow, repositoryDirectory)
      : await cloneRemoteRepository(mainWindow, repositoryDirectory);

    if (!didSync) return;

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['OK'],
      message: 'Repository synced.',
      detail: `Synced ${REMOTE_FLIGHT_DATA_REPO} and set flight-data as the active directory.\n\n${outputDirectory}`
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred while downloading flight data.';
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      buttons: ['OK'],
      message: 'Repository sync failed.',
      detail: message
    });
  }
}

// electron-updater is CommonJS; destructure from the default import so the
// named binding resolves correctly under the bundler.
const { autoUpdater } = updaterPkg;

let autoUpdaterInitialized = false;
let manualUpdateCheck = false;

function initAutoUpdater(mainWindow: BrowserWindow) {
  if (autoUpdaterInitialized) {
    return;
  }
  autoUpdaterInitialized = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    logMain('updater:update-available', { version: info.version });
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Rocket Flight Data ${info.version} is available.`,
      detail: 'Download it now? You can keep working while it downloads in the background.'
    });
    manualUpdateCheck = false;
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((error) => logMainError('updater:download', error));
    }
  });

  autoUpdater.on('update-not-available', () => {
    logMain('updater:update-not-available');
    if (manualUpdateCheck) {
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'No updates',
        message: 'You are running the latest version.'
      });
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow.setProgressBar(progress.percent / 100);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    logMain('updater:update-downloaded', { version: info.version });
    mainWindow.setProgressBar(-1);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Rocket Flight Data ${info.version} has been downloaded.`,
      detail: 'Restart now to install it? It will also install automatically next time you quit.'
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    logMainError('updater:error', error);
    if (manualUpdateCheck) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update error',
        message: 'Could not check for updates.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    manualUpdateCheck = false;
  });
}

function checkForUpdates(mainWindow: BrowserWindow, manual: boolean) {
  if (!app.isPackaged) {
    if (manual) {
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Updates',
        message: 'Auto-update is only available in the installed app.',
        detail: 'Run the installed (Setup) build to receive updates from GitHub releases.'
      });
    }
    return;
  }

  initAutoUpdater(mainWindow);
  manualUpdateCheck = manual;
  autoUpdater.checkForUpdates().catch((error) => {
    logMainError('updater:check', error);
    if (manual) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update error',
        message: 'Could not check for updates.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    manualUpdateCheck = false;
  });
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
      mainWindow.setBackgroundColor(themeBackgroundColor(currentTheme));
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
      label: 'GitHub',
      submenu: [
        {
          label: 'Sync Repository From GitHub',
          click: () => {
            void downloadRemoteFlightData(mainWindow);
          }
        },
        {
          label: 'Sync Repository From GitHub To...',
          click: () => {
            void downloadRemoteFlightDataToChosenLocation(mainWindow);
          }
        },
        {
          label: 'Submit Data as Pull Request',
          click: () => {
            mainWindow.webContents.send('menu:submit-data');
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => {
            checkForUpdates(mainWindow, true);
          }
        },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false
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
    icon: getBundledIconPath(),
    backgroundColor: themeBackgroundColor(currentTheme),
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

  mainWindow.on('unresponsive', () => {
    logMain('window:unresponsive');
  });
  mainWindow.on('responsive', () => {
    logMain('window:responsive');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logMain('window:render-process-gone', details);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logMain('window:did-finish-load');
  });

  buildAppMenu(mainWindow);

  // Silent check on launch; the Help menu offers a manual check with feedback.
  mainWindow.webContents.once('did-finish-load', () => {
    checkForUpdates(mainWindow, false);
  });
}

ipcMain.handle('import:get-config', () => getImportConfig());
ipcMain.handle('import:get-output-directory', () => outputDirectory);
ipcMain.handle('theme:get', () => currentTheme);
ipcMain.handle('git-data:preview-submit', () =>
  runLogged('ipc:git-data:preview-submit', { outputDirectory }, () => previewGitDataSubmit())
);
ipcMain.handle('git-data:submit', (_event, request: SubmitGitDataRequest) =>
  runLogged(
    'ipc:git-data:submit',
    { outputDirectory, selectedCount: request.selectedPaths.length },
    () => submitGitDataChanges(request)
  )
);
ipcMain.handle('import:list-flights', () =>
  runLogged('ipc:import:list-flights', { outputDirectory }, () => listFlights(outputDirectory))
);
ipcMain.handle('import:detect-altimeter', (_event, filePaths: string[]) =>
  runLogged(
    'ipc:import:detect-altimeter',
    { fileCount: filePaths.length, filePaths },
    () => detectAltimeter(filePaths)
  )
);
ipcMain.handle('dataset:read', (_event, datasetDirectory: string, options?: { sanitize?: boolean }) =>
  runLogged(
    'ipc:dataset:read',
    { datasetDirectory, outputDirectory, sanitize: options?.sanitize !== false },
    () => readImportedDataset(outputDirectory, datasetDirectory, options)
  )
);
ipcMain.handle(
  'dataset:save-attributes',
  (_event, request: { datasetDirectory: string; attributes: { key: string; value: string }[] }) =>
    runLogged(
      'ipc:dataset:save-attributes',
      {
        datasetDirectory: request.datasetDirectory,
        outputDirectory,
        attributeCount: request.attributes.length
      },
      () => saveImportedDatasetAttributes(outputDirectory, request.datasetDirectory, request.attributes)
    )
);
ipcMain.handle('flight:read-attributes', (_event, flightDirectoryName: string) =>
  runLogged(
    'ipc:flight:read-attributes',
    { flightDirectoryName, outputDirectory },
    () => readFlightAttributes(outputDirectory, flightDirectoryName)
  )
);
ipcMain.handle(
  'flight:save-attributes',
  (_event, request: { flightDirectoryName: string; attributes: { key: string; value: string }[] }) =>
    runLogged(
      'ipc:flight:save-attributes',
      {
        flightDirectoryName: request.flightDirectoryName,
        outputDirectory,
        attributeCount: request.attributes.length
      },
      () => saveFlightAttributes(outputDirectory, request.flightDirectoryName, request.attributes)
    )
);
ipcMain.handle(
  'import:preview',
  (_event, request: { altimeterId: string; filePaths: string[] }) =>
    runLogged(
      'ipc:import:preview',
      {
        altimeterId: request.altimeterId,
        fileCount: request.filePaths.length,
        filePaths: request.filePaths
      },
      () => previewImport(request.altimeterId, request.filePaths)
    )
);
ipcMain.handle('import:save', (_event, request: SaveImportRequest) =>
  runLogged(
    'ipc:import:save',
    {
      altimeterId: request.altimeterId,
      fileCount: request.filePaths.length,
      flightMode: request.flightMode,
      outputDirectory
    },
    () => saveImport(outputDirectory, request)
  )
);
ipcMain.handle('debug:log', (_event, payload: { message: string; data?: unknown }) => {
  logRenderer(payload.message, payload.data);
});

process.on('uncaughtException', (error) => {
  logMainError('process:uncaught-exception', error);
});
process.on('unhandledRejection', (reason) => {
  logMainError('process:unhandled-rejection', reason);
});
app.on('child-process-gone', (_event, details) => {
  logMain('app:child-process-gone', details);
});

app.whenReady().then(async () => {
  const relaunching = await ensureLinuxAppImageIntegration();
  if (relaunching) return;

  await ensureOutputDirectory(outputDirectory);
  logMain('app:ready');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  logMain('app:window-all-closed', { platform: process.platform });
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
