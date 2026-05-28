import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AltimeterImporter, ParsedImport } from './types';

const UINT32_MAX = 4294967295;

function isUnsetTimestamp(value: number): boolean {
  return !Number.isFinite(value) || value === UINT32_MAX || value <= 0;
}

function formatUnixSecondsTimestamp(value: number): string {
  return new Date(value * 1000).toISOString();
}

function stringifyValue(key: string, value: unknown): string {
  if (typeof value === 'number' && key.endsWith('_timestamp')) {
    return isUnsetTimestamp(value) ? '' : formatUnixSecondsTimestamp(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return String(value);
  }
  return JSON.stringify(value);
}

function flattenJsonToAttributes(
  value: unknown,
  prefix: string,
  out: Record<string, string>
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nextKey = prefix ? `${prefix}_${key}` : key;
      flattenJsonToAttributes(child, nextKey, out);
    }
    return;
  }
  out[prefix] = stringifyValue(prefix, value);
}

function parseCsvLine(line: string): string[] {
  return line.split(',');
}

export const fcbImporter: AltimeterImporter = {
  id: 'fcb',
  name: 'FCB',
  async parse(filePaths: string[]): Promise<ParsedImport> {
    const csvFiles = filePaths.filter((p) => path.extname(p).toLowerCase() === '.csv');
    const jsonFiles = filePaths.filter((p) => path.extname(p).toLowerCase() === '.json');

    const warnings: string[] = [];
    const attributes: Record<string, string> = {};

    for (const jsonFile of jsonFiles) {
      try {
        const json = JSON.parse(await readFile(jsonFile, 'utf8'));
        flattenJsonToAttributes(json, '', attributes);
      } catch (error) {
        warnings.push(`${path.basename(jsonFile)}: failed to parse JSON metadata (${(error as Error).message})`);
      }
    }

    if (csvFiles.length === 0) {
      warnings.push('FCB import requires a .csv data file.');
      return {
        headers: [],
        rows: [],
        attributes,
        warnings,
        sourceFiles: csvFiles
      };
    }

    let headers: string[] = [];
    const rows: string[][] = [];

    for (const csvFile of csvFiles) {
      const contents = await readFile(csvFile, 'utf8');
      const lines = contents.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length === 0) {
        warnings.push(`${path.basename(csvFile)}: empty file.`);
        continue;
      }

      // FCB CSV uses a leading unnamed index column; drop it from header + rows.
      const fileHeaders = parseCsvLine(lines[0]).slice(1).map((cell) => cell.trim());
      if (headers.length === 0) {
        headers = fileHeaders;
      }

      for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line).slice(1);
        if (cells.length === 0) continue;
        rows.push(headers.map((_, index) => (cells[index] ?? '').trim()));
      }
    }

    if (rows.length === 0) {
      warnings.push('No FCB data rows were found in the selected file(s).');
    }

    return {
      headers,
      rows,
      attributes,
      warnings,
      sourceFiles: csvFiles
    };
  }
};
