import fs from 'node:fs';
import path from 'node:path';
import type { AttributeRow, FlightData, FlightEvent } from '../shared/types';

function splitTsvLine(line: string): string[] {
  return line.split('\t');
}

function parseNumber(s: string): number | null {
  if (s === '' || s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function readAttributes(filePath: string): AttributeRow[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  // First line is header: key\tvalue\tsource
  const out: AttributeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitTsvLine(lines[i]);
    if (parts.length < 2) continue;
    const [key, value, source = ''] = parts;
    if (!key) continue;
    out.push({ key, value: value ?? '', source });
  }
  return out;
}

export function writeAttributes(filePath: string, rows: AttributeRow[]): void {
  const header = ['key', 'value', 'source'].join('\t');
  const body = rows
    .filter((r) => r.key.length > 0)
    .map((r) => [r.key, r.value, r.source ?? ''].join('\t'))
    .join('\n');
  const out = header + '\n' + body + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, out, 'utf8');
}

/** Returns true if the given column has at least two distinct numeric values. */
function columnHasVariation(rows: (string | number)[][], colIdx: number): boolean {
  let seen: number | null = null;
  for (let r = 0; r < rows.length; r++) {
    const v = rows[r][colIdx];
    if (typeof v !== 'number') continue;
    if (seen === null) seen = v;
    else if (v !== seen) return true;
  }
  return false;
}

const TIME_PREFERENCE = [
  'generated_time_s',
  'timestamp_s',
  'time_s',
  'time',
  'timestampMs',
  'timestamp_ms',
  'time_stamp_ms',
  'timestamp',
];

/** Pick the best time column. Validates that the chosen column has variation. */
function pickTimeColumn(
  columns: string[],
  rows: (string | number)[][],
  hint: string | null
): string | null {
  const candidates: string[] = [];
  if (hint && columns.includes(hint)) candidates.push(hint);
  for (const p of TIME_PREFERENCE) {
    if (columns.includes(p) && !candidates.includes(p)) candidates.push(p);
  }
  const fallback = columns.find((c) => /(^|_)(time|tick|ts)(_|$)/i.test(c));
  if (fallback && !candidates.includes(fallback)) candidates.push(fallback);

  for (const c of candidates) {
    const idx = columns.indexOf(c);
    if (idx < 0) continue;
    if (rows.length === 0 || columnHasVariation(rows, idx)) return c;
  }
  return candidates[0] ?? null;
}

function timeScaleFor(columnName: string | null): number {
  if (!columnName) return 1;
  // ms in camelCase (e.g. timestampMs) or snake_case (e.g. timestamp_ms, time_stamp_ms).
  if (/[a-z]Ms$|^Ms$|_ms$/i.test(columnName)) return 0.001;
  return 1;
}

const STATE_NAMES_KNOWN: Record<string, string> = {
  '0': 'PRE_FLIGHT',
  '1': 'ASCENT',
  '2': 'DESCENT',
  '3': 'POST_FLIGHT',
  '4': 'UNKNOWN',
};

function stateName(v: number): string {
  const k = String(v | 0);
  return STATE_NAMES_KNOWN[k] ?? `STATE_${k}`;
}

/**
 * Detect flight events using generic column-name patterns. Returns events with times in seconds.
 *
 * - Any column named `flightState` or `state` (case-insensitive): transitions → "STATE_A → STATE_B".
 * - Any boolean-ish column matching /fired$/i: 0→1 → "<name> fired".
 * - Any boolean-ish column matching /(cont|continuity)$/i: 1→0 → "<name> continuity lost".
 */
function detectEvents(
  columns: string[],
  rows: (string | number)[][],
  timeColumn: string | null,
  timeScale: number
): { events: FlightEvent[]; flightWindowS: { startS: number; endS: number } | null } {
  if (!timeColumn) return { events: [], flightWindowS: null };
  const iTime = columns.indexOf(timeColumn);
  if (iTime < 0 || rows.length === 0) return { events: [], flightWindowS: null };

  const t0Raw = Number(rows[0][iTime]);
  if (!Number.isFinite(t0Raw)) return { events: [], flightWindowS: null };
  const tSec = (r: number) => (Number(rows[r][iTime]) - t0Raw) * timeScale;

  // Identify event-relevant columns.
  const stateCols: number[] = [];
  const firedCols: number[] = [];
  const contCols: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (/^(flightState|flight_state|state|fcb_state_number)$/i.test(c)) stateCols.push(i);
    else if (/fired$/i.test(c)) firedCols.push(i);
    else if (/(continuity|cont)$/i.test(c)) contCols.push(i);
  }

  const events: FlightEvent[] = [];

  // State transitions.
  let flightWindowS: { startS: number; endS: number } | null = null;
  for (const iState of stateCols) {
    let prev: number | null = null;
    let firstNonPre = -1;
    let lastNonPost = -1;
    let transitions = 0;
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][iState];
      if (typeof v !== 'number') continue;
      if (prev !== null && v !== prev) {
        events.push({
          timeS: tSec(r),
          label: `${stateName(prev)} → ${stateName(v)}`,
          color: '#34d399',
        });
        transitions++;
      }
      if (v !== 0 && firstNonPre < 0) firstNonPre = r;
      if (v !== 3) lastNonPost = r;
      prev = v;
    }
    // Only set a flight window if we saw at least one state transition — otherwise
    // a column that's constant (e.g. firmware never updated state) would span everything.
    if (transitions > 0 && firstNonPre >= 0 && lastNonPost >= 0 && lastNonPost >= firstNonPre) {
      const pad = 5;
      const startS = tSec(firstNonPre) - pad;
      const endS = tSec(lastNonPost) + pad;
      if (!flightWindowS) flightWindowS = { startS, endS };
      else {
        flightWindowS.startS = Math.min(flightWindowS.startS, startS);
        flightWindowS.endS = Math.max(flightWindowS.endS, endS);
      }
    }
  }

  // Pyro fires (0 → 1).
  for (const iCol of firedCols) {
    const name = columns[iCol];
    let prev: number | null = null;
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][iCol];
      if (typeof v !== 'number') continue;
      if (prev === 0 && v === 1) {
        events.push({ timeS: tSec(r), label: `${name} fired`, color: '#a855f7' }); // purple
      }
      prev = v;
    }
  }

  // Continuity loss (1 → 0).
  for (const iCol of contCols) {
    const name = columns[iCol];
    let prev: number | null = null;
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][iCol];
      if (typeof v !== 'number') continue;
      if (prev === 1 && v === 0) {
        events.push({ timeS: tSec(r), label: `${name} lost`, color: '#f87171' }); // red
      }
      prev = v;
    }
  }

  events.sort((a, b) => a.timeS - b.timeS);
  return { events, flightWindowS };
}

/**
 * Read a data.tsv file and infer whether it's telemetry or a text log.
 *
 * Handles formats observed:
 *  - Telemetry: header starts with an empty first column (index), then named columns.
 *  - Telemetry: header first column is named (e.g. `timestamp_s`).
 *  - Text log:  header is `generated_time_s\tRUN START ...` followed by `<int>\t<text>` rows.
 *  - Empty: just `generated_time_s` with no rows.
 */
export function readData(filePath: string, timeColumnHint: string | null): FlightData {
  const empty: FlightData = {
    columns: [],
    rows: [],
    isTelemetry: false,
    timeColumn: timeColumnHint,
    timeScaleToSeconds: 1,
    numericColumns: [],
    rowCount: 0,
    events: [],
    flightWindowS: null,
  };
  if (!fs.existsSync(filePath)) return empty;

  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return empty;

  const rawHeader = splitTsvLine(lines[0]);
  const dataLines = lines.slice(1);

  // Text-log format: header second cell looks like "RUN START ...".
  const looksLikeLog =
    rawHeader.length === 2 && /^RUN START/i.test((rawHeader[1] ?? '').trim());

  if (looksLikeLog) {
    const columns = [rawHeader[0] || 'time_s', 'log'];
    const rows: (string | number)[][] = [];
    for (const line of dataLines) {
      if (!line) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) {
        rows.push([parseNumber(line) ?? line, '']);
      } else {
        const t = line.slice(0, tabIdx);
        const log = line.slice(tabIdx + 1);
        rows.push([parseNumber(t) ?? t, log]);
      }
    }
    return {
      ...empty,
      columns,
      rows,
      isTelemetry: false,
      timeColumn: columns[0],
      numericColumns: [columns[0]],
      rowCount: rows.length,
    };
  }

  // Telemetry, possibly with a leading unnamed index column.
  const dropFirst = rawHeader[0] === '' || rawHeader[0] === undefined;
  const columns = dropFirst ? rawHeader.slice(1) : rawHeader.slice();
  for (let i = 0; i < columns.length; i++) {
    if (!columns[i]) columns[i] = `col_${i}`;
  }

  const rows: (string | number)[][] = [];
  const numericCandidate = new Array<boolean>(columns.length).fill(true);
  const sampleSeen = new Array<number>(columns.length).fill(0);
  const SAMPLE_TARGET = 50;

  for (const line of dataLines) {
    if (!line) continue;
    const parts = splitTsvLine(line);
    const sliced = dropFirst ? parts.slice(1) : parts;
    const row: (string | number)[] = new Array(columns.length);
    for (let i = 0; i < columns.length; i++) {
      const cell = sliced[i] ?? '';
      const n = parseNumber(cell);
      if (n !== null) {
        row[i] = n;
        if (sampleSeen[i] < SAMPLE_TARGET) sampleSeen[i]++;
      } else {
        row[i] = cell;
        if (cell !== '' && sampleSeen[i] < SAMPLE_TARGET) {
          numericCandidate[i] = false;
          sampleSeen[i]++;
        }
      }
    }
    rows.push(row);
  }

  const numericColumns = columns.filter((_, i) => numericCandidate[i]);
  const timeColumn = pickTimeColumn(columns, rows, timeColumnHint);
  const timeScale = timeScaleFor(timeColumn);
  const { events, flightWindowS } = detectEvents(columns, rows, timeColumn, timeScale);

  return {
    columns,
    rows,
    isTelemetry: true,
    timeColumn,
    timeScaleToSeconds: timeScale,
    numericColumns,
    rowCount: rows.length,
    events,
    flightWindowS,
  };
}
