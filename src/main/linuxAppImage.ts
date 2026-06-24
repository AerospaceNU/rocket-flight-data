import { app, dialog } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logMain, logMainError } from './logger';

export const APP_ID = 'com.rocket-flight-data.app';
export const APP_NAME = 'Rocket Flight Data';
export const APP_CLASS = 'rocket-flight-data';

const INSTALL_DIRECTORY_NAME = APP_NAME;
const APPIMAGE_NAME = `${APP_NAME}.AppImage`;
const APPIMAGE_ARGS = ['--no-sandbox'];

function getXdgPath(envName: string, fallback: string): string {
  const configured = process.env[envName];
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(os.homedir(), fallback);
}

function getInstallPaths() {
  const dataHome = getXdgPath('XDG_DATA_HOME', '.local/share');
  const installDir = path.join(dataHome, INSTALL_DIRECTORY_NAME);

  return {
    dataHome,
    installDir,
    appImagePath: path.join(installDir, APPIMAGE_NAME),
    desktopDir: path.join(dataHome, 'applications'),
    desktopPath: path.join(dataHome, 'applications', `${APP_ID}.desktop`),
    iconThemeDir: path.join(dataHome, 'icons', 'hicolor'),
    iconDir: path.join(dataHome, 'icons', 'hicolor', '256x256', 'apps'),
    iconPath: path.join(dataHome, 'icons', 'hicolor', '256x256', 'apps', `${APP_ID}.png`)
  };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function quoteDesktopExecArg(value: string): string {
  return `"${value.replace(/(["\\`$])/g, '\\$1')}"`;
}

function buildDesktopEntry(appImagePath: string): string {
  const execArgs = APPIMAGE_ARGS.join(' ');
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Explore and submit rocket flight data',
    `Exec=${quoteDesktopExecArg(appImagePath)} ${execArgs}`,
    `Icon=${APP_ID}`,
    'Terminal=false',
    'Categories=Science;',
    'StartupNotify=true',
    `StartupWMClass=${APP_CLASS}`
  ].join('\n') + '\n';
}

async function writeTextFileIfChanged(filePath: string, text: string, mode: number): Promise<boolean> {
  try {
    if ((await fs.promises.readFile(filePath, 'utf8')) === text) return false;
  } catch {
    // Missing or unreadable files are rewritten below.
  }

  await fs.promises.writeFile(filePath, text, { encoding: 'utf8', mode });
  await fs.promises.chmod(filePath, mode);
  return true;
}

async function writeBinaryFileIfChanged(filePath: string, bytes: Buffer, mode: number): Promise<boolean> {
  try {
    const existing = await fs.promises.readFile(filePath);
    if (existing.equals(bytes)) return false;
  } catch {
    // Missing or unreadable files are rewritten below.
  }

  await fs.promises.writeFile(filePath, bytes, { mode });
  await fs.promises.chmod(filePath, mode);
  return true;
}

export function getBundledIconPath(): string {
  return path.join(app.getAppPath(), 'build', 'icon.png');
}

async function writeDesktopIntegration(paths: ReturnType<typeof getInstallPaths>): Promise<void> {
  await fs.promises.mkdir(paths.desktopDir, { recursive: true });
  await fs.promises.mkdir(paths.iconDir, { recursive: true });

  const iconBytes = await fs.promises.readFile(getBundledIconPath());
  const iconChanged = await writeBinaryFileIfChanged(paths.iconPath, iconBytes, 0o644);
  const desktopChanged = await writeTextFileIfChanged(
    paths.desktopPath,
    buildDesktopEntry(paths.appImagePath),
    0o644
  );

  if (desktopChanged) execFile('update-desktop-database', [paths.desktopDir], () => {});
  if (iconChanged) execFile('gtk-update-icon-cache', ['-q', paths.iconThemeDir], () => {});

  logMain('linux-appimage:desktop-integration', {
    appImagePath: paths.appImagePath,
    desktopPath: paths.desktopPath,
    iconPath: paths.iconPath,
    desktopChanged,
    iconChanged
  });
}

async function installCurrentAppImage(currentAppImage: string, installedAppImage: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(installedAppImage), { recursive: true });

  const tmpPath = `${installedAppImage}.tmp-${process.pid}`;
  await fs.promises.copyFile(currentAppImage, tmpPath);
  await fs.promises.chmod(tmpPath, 0o755);
  await fs.promises.rename(tmpPath, installedAppImage);
  await fs.promises.chmod(installedAppImage, 0o755);
}

function launchInstalledAppImage(appImagePath: string): void {
  const env = { ...process.env };
  delete env.APPIMAGE;
  delete env.APPDIR;
  delete env.ARGV0;

  const child = spawn(appImagePath, APPIMAGE_ARGS, {
    detached: true,
    stdio: 'ignore',
    env
  });
  child.unref();
}

export async function ensureLinuxAppImageIntegration(): Promise<boolean> {
  if (process.platform !== 'linux' || !app.isPackaged || !process.env.APPIMAGE) {
    return false;
  }

  const currentAppImage = path.resolve(process.env.APPIMAGE);
  const paths = getInstallPaths();

  if (samePath(currentAppImage, paths.appImagePath)) {
    await writeDesktopIntegration(paths);
    return false;
  }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Install and relaunch', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: `Install ${APP_NAME}`,
    message: `Install ${APP_NAME} for this user?`,
    detail:
      `This copies the AppImage to:\n${paths.appImagePath}\n\n` +
      'It also adds an app launcher with the Rocket Flight Data icon. Future updates will run from this stable location instead of wherever the AppImage was downloaded.'
  });

  if (response !== 0) return false;

  try {
    await installCurrentAppImage(currentAppImage, paths.appImagePath);
    await writeDesktopIntegration(paths);
    launchInstalledAppImage(paths.appImagePath);
    app.quit();
    return true;
  } catch (error) {
    logMainError('linux-appimage:install-failed', error, {
      currentAppImage,
      appImagePath: paths.appImagePath
    });
    dialog.showErrorBox(
      `Could not install ${APP_NAME}`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}
