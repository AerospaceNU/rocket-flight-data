import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeRows, type SanitizationConfig } from './sanitization';
import type { AltimeterImporter, ParseOptions, ParsedImport } from './types';

// No range/state/GPS rules needed yet. Add them here to opt RawGPSData into the
// "Sanitize data" toggle (see fcbgroundstationSanitizer.ts for the pattern).
const RAW_GPS_SANITIZATION: SanitizationConfig = {};

const RAW_GPS_HEADERS = ['timestamp', 'latitude', 'longitude', 'altitude'];

function csvCells(line: string) {
  return line.split(',').map((cell) => cell.trim());
}

function isRawGpsHeader(cells: string[]) {
  return RAW_GPS_HEADERS.every((header, index) => cells[index]?.toLowerCase() === header);
}

function isNumericRow(cells: string[]) {
  return RAW_GPS_HEADERS.every((_, index) => Number.isFinite(Number.parseFloat(cells[index] ?? '')));
}

export const rawGpsDataImporter: AltimeterImporter = {
  id: 'rawgpsdata',
  name: 'RawGPSData',
  async parse(filePaths: string[], options?: ParseOptions): Promise<ParsedImport> {
    const rows: string[][] = [];
    const attributes: Record<string, string> = {
      source_format: 'Raw GPS CSV',
      time_units: 's',
      altitude_units: 'm'
    };
    const warnings: string[] = [];

    for (const filePath of filePaths) {
      const contents = await readFile(filePath, 'utf8');
      const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const headerIndex = lines.findIndex((line) => isRawGpsHeader(csvCells(line)));

      if (headerIndex < 0) {
        warnings.push(`${path.basename(filePath)}: no RawGPSData header found`);
        continue;
      }

      let fileRowCount = 0;

      for (const line of lines.slice(headerIndex + 1)) {
        const cells = csvCells(line);

        if (!isNumericRow(cells)) {
          warnings.push(`${path.basename(filePath)}: skipped non-numeric row`);
          continue;
        }

        rows.push(RAW_GPS_HEADERS.map((_, index) => cells[index] ?? ''));
        fileRowCount += 1;
      }

      if (fileRowCount === 0) {
        warnings.push(`${path.basename(filePath)}: no RawGPSData rows found`);
      }
    }

    if (rows.length > 0) {
      attributes.start_timestamp = rows[0][0];
      attributes.end_timestamp = rows[rows.length - 1][0];
      attributes.start_latitude = rows[0][1];
      attributes.start_longitude = rows[0][2];
      attributes.end_latitude = rows[rows.length - 1][1];
      attributes.end_longitude = rows[rows.length - 1][2];
    } else {
      warnings.push('No RawGPSData rows were found in the selected file(s).');
    }

    const { rows: cleanedRows } = sanitizeRows(
      RAW_GPS_HEADERS,
      rows,
      RAW_GPS_SANITIZATION,
      options?.sanitize !== false
    );

    return {
      headers: RAW_GPS_HEADERS,
      rows: cleanedRows,
      attributes,
      warnings,
      sourceFiles: filePaths
    };
  }
};
