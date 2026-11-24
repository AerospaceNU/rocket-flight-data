import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeRows, type SanitizationConfig } from './sanitization';
import type { AltimeterImporter, ParseOptions, ParsedImport } from './types';
import { SERIOUSGOOSE_COLUMN_UNITS } from './columnUnits';

const SERIOUSGOOSE_SANITIZATION: SanitizationConfig = {};

// SeriousGoose text offloads carry their own column-name row (generated from the firmware's log
// struct), so headers are read from the file rather than assumed.
const HEADER_FIRST_COLUMN = 'timestampMs';

// A board's clock only moves forward; a ground station can also decode the odd packet from another board on a
// nearby channel, whose clock (time since its own boot) is unrelated. Packets are grouped into clock tracks
// that each advance by at most MAX_TRACK_STEP_MS (long radio dropouts included).
const MAX_TRACK_STEP_MS = 600_000;
const TRACK_BACKWARD_TOLERANCE_MS = 1_000;

/**
 * Keeps only the rows on the clock track with the most rows, dropping interleaved packets from other boards.
 * Without this a single foreign packet sends the time axis thousands of seconds backwards.
 */
function keepDominantBoardClock(headers: string[], rows: string[][]) {
  const timeIndex = headers.indexOf(HEADER_FIRST_COLUMN);
  if (timeIndex < 0 || rows.length === 0) return { rows, dropped: 0 };

  const tracks: { last: number; rows: number[] }[] = [];
  rows.forEach((row, index) => {
    const time = Number(row[timeIndex]);
    if (!Number.isFinite(time)) return;
    let best: { last: number; rows: number[] } | null = null;
    for (const track of tracks) {
      const step = time - track.last;
      if (step < -TRACK_BACKWARD_TOLERANCE_MS || step > MAX_TRACK_STEP_MS) continue;
      if (!best || Math.abs(step) < Math.abs(time - best.last)) best = track;
    }
    if (best) {
      best.last = Math.max(best.last, time);
      best.rows.push(index);
    } else {
      tracks.push({ last: time, rows: [index] });
    }
  });

  if (tracks.length <= 1) return { rows, dropped: 0 };
  const largest = tracks.reduce((current, track) => (track.rows.length > current.rows.length ? track : current));
  const keep = new Set(largest.rows);
  const kept = rows.filter((_, index) => keep.has(index));
  return { rows: kept, dropped: rows.length - kept.length };
}

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

    const sanitize = options?.sanitize !== false;
    const boardRows = sanitize ? keepDominantBoardClock(headers, rows) : { rows, dropped: 0 };
    if (boardRows.dropped > 0) {
      warnings.push(`Dropped ${boardRows.dropped} packets whose clock belongs to another board (off-channel reception)`);
    }
    const { rows: cleanedRows } = sanitizeRows(headers, boardRows.rows, SERIOUSGOOSE_SANITIZATION, sanitize);

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
