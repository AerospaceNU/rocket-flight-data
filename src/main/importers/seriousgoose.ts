import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeRows, type SanitizationConfig } from './sanitization';
import type { AltimeterImporter, ParseOptions, ParsedImport } from './types';
import { SERIOUSGOOSE_COLUMN_UNITS } from './columnUnits';

const SERIOUSGOOSE_SANITIZATION: SanitizationConfig = {};

// SeriousGoose text offloads carry their own column-name row (generated from the firmware's log
// struct), so headers are read from the file rather than assumed.
const HEADER_FIRST_COLUMN = 'timestampMs';

function parseConfigLine(line: string): Record<string, string> {
  const body = line.replace(/^CONFIG[\s\t]+/, '').trim();
  if (!body || body.startsWith('<')) return {};

  return body.split(/\t+/).reduce<Record<string, string>>((attributes, part) => {
    const trimmed = part.trim();
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex > 0) attributes[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
    return attributes;
  }, {});
}

export const seriousGooseImporter: AltimeterImporter = {
  id: 'seriousgoose',
  name: 'SeriousGoose',
  async parse(filePaths: string[], options?: ParseOptions): Promise<ParsedImport> {
    let headers: string[] = [];
    const rows: string[][] = [];
    const attributes: Record<string, string> = {};
    const warnings: string[] = [];

    for (const filePath of filePaths) {
      const contents = await readFile(filePath, 'utf8');
      let skipped = 0;

      for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('CONFIG\t') || line.startsWith('CONFIG ')) {
          Object.assign(attributes, parseConfigLine(line));
          continue;
        }

        if (line.startsWith(`${HEADER_FIRST_COLUMN}\t`)) {
          const fileHeaders = line.split('\t').map((header) => header.trim());
          if (headers.length === 0) {
            headers = fileHeaders;
          } else if (fileHeaders.join('\t') !== headers.join('\t')) {
            warnings.push(`${path.basename(filePath)}: column names differ from the first file; keeping the first file's`);
          }
          continue;
        }

        if (!/^\d/.test(line)) continue;

        const cells = line.split('\t');
        if (headers.length === 0 || cells.length !== headers.length) {
          skipped += 1;
          continue;
        }
        rows.push(cells);
      }

      if (skipped > 0) {
        warnings.push(`${path.basename(filePath)}: skipped ${skipped} rows without a matching column-name row`);
      }
    }

    if (rows.length === 0) {
      warnings.push('No SeriousGoose data rows were found in the selected file(s).');
    }

    const { rows: cleanedRows } = sanitizeRows(headers, rows, SERIOUSGOOSE_SANITIZATION, options?.sanitize !== false);

    return {
      headers,
      rows: cleanedRows,
      columnUnits: SERIOUSGOOSE_COLUMN_UNITS,
      attributes,
      warnings,
      sourceFiles: filePaths
    };
  }
};
