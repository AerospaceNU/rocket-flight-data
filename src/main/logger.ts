import fs from 'node:fs';
import path from 'node:path';

let logDirectory = '';
let logFilePath = '';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function appendLine(line: string): void {
  if (!logFilePath) return;

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to write debug log:', error);
  }
}

export function initLogger(baseDirectory: string): void {
  logDirectory = path.join(baseDirectory, 'logs');
  logFilePath = path.join(logDirectory, 'app-debug.log');
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(logFilePath, '', 'utf8');
  } catch (error) {
    console.error('Failed to initialize debug log:', error);
  }
  appendLine(`${timestamp()} [main] logger initialized`);
}

export function getLogDirectory(): string {
  return logDirectory;
}

export function getLogFilePath(): string {
  return logFilePath;
}

export function logMain(message: string, data?: unknown): void {
  const suffix = data === undefined ? '' : ` ${safeStringify(data)}`;
  appendLine(`${timestamp()} [main] ${message}${suffix}`);
}

export function logMainError(message: string, error: unknown, data?: unknown): void {
  const payload = {
    ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : {}),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
  appendLine(`${timestamp()} [main] ${message} ${safeStringify(payload)}`);
}

export function logRenderer(message: string, data?: unknown): void {
  const suffix = data === undefined ? '' : ` ${safeStringify(data)}`;
  appendLine(`${timestamp()} [renderer] ${message}${suffix}`);
}
