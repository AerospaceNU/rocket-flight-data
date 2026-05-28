import { readFile } from 'node:fs/promises';
import type { AltimeterImporter, ParsedImport } from './types';

const STRATOLOGGER_HEADERS = [
  'timeS',
  'altitudeFt',
  'velocityFtS',
  'temperatureF',
  'batteryVoltageV'
];

function csvCells(line: string) {
  return line.split(',').map((cell) => cell.trim());
}

function normalizeAttributeKey(key: string) {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseHeaderAttribute(line: string) {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex < 0) {
    return null;
  }

  const key = normalizeAttributeKey(line.slice(0, separatorIndex));
  const value = line.slice(separatorIndex + 1).trim();

  return key ? { key, value } : null;
}

export const stratoLoggerCfImporter: AltimeterImporter = {
  id: 'stratologgercf',
  name: 'StratoLoggerCF',
  async parse(filePaths: string[]): Promise<ParsedImport> {
    const rows: string[][] = [];
    const attributes: Record<string, string> = {};
    const warnings: string[] = [];

    for (const filePath of filePaths) {
      const contents = await readFile(filePath, 'utf8');
      const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const dataStartIndex = lines.findIndex((line) => line.toLowerCase().startsWith('data:'));

      if (dataStartIndex < 0) {
        warnings.push(`${filePath}: no Data section found`);
        continue;
      }

      lines.slice(0, dataStartIndex).forEach((line, index) => {
        if (index === 0 && !line.includes(':')) {
          attributes.product = line;
          return;
        }

        const attribute = parseHeaderAttribute(line);
        if (attribute) {
          attributes[attribute.key] = attribute.value;
        }
      });

      for (const line of lines.slice(dataStartIndex + 1)) {
        const cells = csvCells(line);

        if (cells.length >= STRATOLOGGER_HEADERS.length && Number.isFinite(Number.parseFloat(cells[0]))) {
          rows.push(STRATOLOGGER_HEADERS.map((_, index) => cells[index] ?? ''));
        }
      }
    }

    if (rows.length === 0) {
      warnings.push('No StratoLoggerCF data rows were found in the selected file(s).');
    }

    return {
      headers: STRATOLOGGER_HEADERS,
      rows,
      attributes,
      warnings,
      sourceFiles: filePaths
    };
  }
};
