import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeRows, type SanitizationConfig } from './sanitization';
import type { AltimeterImporter, ParseOptions, ParsedImport } from './types';
import { SILLYGOOSE_COLUMN_UNITS } from './columnUnits';

// No range/state/GPS rules needed yet. Add them here to opt SillyGoose into the
// "Sanitize data" toggle (see fcbgroundstationSanitizer.ts for the pattern).
const SILLYGOOSE_SANITIZATION: SanitizationConfig = {};

const SILLYGOOSE_HEADERS = [
  'timestampMs',
  'pressurePa',
  'tempK',
  'accelX',
  'accelY',
  'accelZ',
  'gyroX',
  'gyroY',
  'gyroZ',
  'imuTemp',
  'battV',
  'altitudeM',
  'velocityMS',
  'accelerationMSS',
  'unfiltAlt',
  'flightState',
  'drogueCont',
  'drogueFired',
  'mainCont',
  'mainFired',
  'tiltMagnitudeDeg',
  'angularVelRadS_x',
  'angularVelRadS_y',
  'angularVelRadS_z',
  'quaternion_a',
  'quaternion_b',
  'quaternion_c',
  'quaternion_d'
];

const OLD_FORMAT_MIN_COLUMNS = 20;

function parseConfigLine(line: string): Record<string, string> {
  const body = line.replace(/^CONFIG[\s\t]+/, '').trim();
  if (!body) return {};

  const parts = body.includes('\t') ? body.split(/\t+/) : body.split(/\s+(?=[A-Z0-9_]+=)/);

  return parts.reduce<Record<string, string>>((attributes, part) => {
    const trimmed = part.trim();
    const equalsIndex = trimmed.indexOf('=');

    if (equalsIndex <= 0) {
      return attributes;
    }

    attributes[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
    return attributes;
  }, {});
}

function normalizeRow(line: string, headers: string[], warnings: string[], filePath: string) {
  const cells = line.split(/[\s\t,]+/).filter(Boolean);

  if (cells.length < OLD_FORMAT_MIN_COLUMNS) {
    warnings.push(`${path.basename(filePath)}: skipped row with ${cells.length} columns`);
    return null;
  }

  while (headers.length < cells.length) {
    headers.push(`extra_${headers.length - SILLYGOOSE_HEADERS.length + 1}`);
  }

  return headers.map((_, index) => cells[index] ?? '');
}

export const sillyGooseImporter: AltimeterImporter = {
  id: 'sillygoose',
  name: 'SillyGoose',
  async parse(filePaths: string[], options?: ParseOptions): Promise<ParsedImport> {
    const headers = [...SILLYGOOSE_HEADERS];
    const rows: string[][] = [];
    const attributes: Record<string, string> = {};
    const warnings: string[] = [];

    for (const filePath of filePaths) {
      const contents = await readFile(filePath, 'utf8');
      const lines = contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (line.startsWith('CONFIG\t') || line.startsWith('CONFIG ')) {
          Object.assign(attributes, parseConfigLine(line));
          continue;
        }

        if (/^\d/.test(line)) {
          const normalized = normalizeRow(line, headers, warnings, filePath);
          if (normalized) {
            rows.push(normalized);
          }
        }
      }
    }

    if (rows.length === 0) {
      warnings.push('No SillyGoose data rows were found in the selected file(s).');
    }

    const paddedRows = rows.map((row) => headers.map((_, index) => row[index] ?? ''));
    const { rows: cleanedRows } = sanitizeRows(
      headers,
      paddedRows,
      SILLYGOOSE_SANITIZATION,
      options?.sanitize !== false
    );

    return {
      headers,
      rows: cleanedRows,
      columnUnits: SILLYGOOSE_COLUMN_UNITS,
      attributes,
      warnings,
      sourceFiles: filePaths
    };
  }
};
