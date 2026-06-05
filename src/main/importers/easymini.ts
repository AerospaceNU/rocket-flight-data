import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeRows, type SanitizationConfig } from './sanitization';
import type { AltimeterImporter, ParseOptions, ParsedImport } from './types';
import { EASYMINI_COLUMN_UNITS } from './columnUnits';

// No range/state/GPS rules needed yet. Add them here to opt EasyMini into the
// "Sanitize data" toggle (see fcbgroundstationSanitizer.ts for the pattern).
const EASYMINI_SANITIZATION: SanitizationConfig = {};

const EASYMINI_HEADERS = [
  'version',
  'serial',
  'flight',
  'time',
  'state',
  'state_name',
  'acceleration',
  'pressure',
  'altitude',
  'height',
  'speed',
  'temperature',
  'drogue_voltage',
  'main_voltage',
  'battery_voltage'
];

function csvCells(line: string) {
  return line.split(',').map((cell) => cell.trim());
}

function parseCsv(contents: string) {
  const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerLine = lines.find((line) => line.startsWith('#'));
  const headers = headerLine ? csvCells(headerLine.replace(/^#/, '')) : EASYMINI_HEADERS;
  const rows = lines
    .filter((line) => !line.startsWith('#'))
    .map((line) => csvCells(line))
    .filter((cells) => cells.length >= headers.length);
  const attributes: Record<string, string> = {};

  if (rows[0]) {
    for (const key of ['version', 'serial', 'flight']) {
      const index = headers.indexOf(key);
      if (index >= 0) {
        attributes[key] = rows[0][index];
      }
    }
  }

  return { headers, rows, attributes };
}

export const easyMiniImporter: AltimeterImporter = {
  id: 'easymini',
  name: 'EasyMini',
  async parse(filePaths: string[], options?: ParseOptions): Promise<ParsedImport> {
    const rows: string[][] = [];
    const attributes: Record<string, string> = {};
    const warnings: string[] = [];

    for (const filePath of filePaths) {
      const extension = path.extname(filePath).toLowerCase();

      if (extension !== '.csv') {
        warnings.push(`${path.basename(filePath)}: EasyMini imports require an AltOS CSV export.`);
        continue;
      }

      const parsed = parseCsv(await readFile(filePath, 'utf8'));
      rows.push(...parsed.rows.map((row) => EASYMINI_HEADERS.map((_, index) => row[index] ?? '')));
      Object.assign(attributes, parsed.attributes, { source_format: 'AltOS CSV' });
    }

    if (rows.length === 0) {
      warnings.push('No EasyMini CSV rows were found in the selected file(s).');
    }

    const { rows: cleanedRows } = sanitizeRows(
      EASYMINI_HEADERS,
      rows,
      EASYMINI_SANITIZATION,
      options?.sanitize !== false
    );

    return {
      headers: EASYMINI_HEADERS,
      rows: cleanedRows,
      columnUnits: EASYMINI_COLUMN_UNITS,
      attributes,
      warnings,
      sourceFiles: filePaths
    };
  }
};
