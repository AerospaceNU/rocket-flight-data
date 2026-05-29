import type { ImportedDataset } from '../importTypes';
import {
  automaticChecksEnabled,
  normalizedHeader,
  parseNumber,
  type AutomaticCheckOptions
} from './core';

type TimeColumnDefinition = {
  names: string[];
  secondsPerUnit: number;
  relativeToFirstValue: boolean;
};

export type TimeAxis = {
  values: number[];
  title: string;
  hoverLabel: string;
};

const TIME_COLUMNS: TimeColumnDefinition[] = [
  { names: ['timestampms', 'timestamp_ms'], secondsPerUnit: 0.001, relativeToFirstValue: true },
  { names: ['timestampus', 'timestamp_us'], secondsPerUnit: 0.000001, relativeToFirstValue: true },
  { names: ['timestampns', 'timestamp_ns'], secondsPerUnit: 0.000000001, relativeToFirstValue: true },
  { names: ['timestamp', 'timestamps', 'timestamp_s'], secondsPerUnit: 1, relativeToFirstValue: true },
  { names: ['timems', 'time_ms', 'elapsedms', 'elapsed_ms'], secondsPerUnit: 0.001, relativeToFirstValue: false },
  { names: ['timeus', 'time_us', 'elapsedus', 'elapsed_us'], secondsPerUnit: 0.000001, relativeToFirstValue: false },
  { names: ['timens', 'time_ns', 'elapsedns', 'elapsed_ns'], secondsPerUnit: 0.000000001, relativeToFirstValue: false },
  { names: ['time', 'times', 'time_s', 'elapseds', 'elapsed_s', 'elapsedtime', 'elapsed_time'], secondsPerUnit: 1, relativeToFirstValue: false }
];

function timeColumnStats(rows: string[][], columnIndex: number) {
  let first: number | null = null;
  let min: number | null = null;
  let max: number | null = null;
  let previous: number | null = null;
  const deltas: number[] = [];

  for (const row of rows) {
    const value = parseNumber(row[columnIndex]);
    if (value === null) continue;
    if (first === null) first = value;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
    if (previous !== null) {
      const delta = Math.abs(value - previous);
      if (delta > 0) deltas.push(delta);
    }
    previous = value;
  }

  const sortedDeltas = deltas.sort((left, right) => left - right);
  const medianDelta = sortedDeltas[Math.floor(sortedDeltas.length / 2)] ?? null;

  return { first, min, max, medianDelta };
}

function isLikelyMillisecondTimestamp(
  header: string,
  relativeToFirstValue: boolean,
  secondsPerUnit: number,
  stats: { min: number | null; max: number | null; medianDelta: number | null }
) {
  if (!relativeToFirstValue || secondsPerUnit !== 1) return false;
  if (stats.min === null || stats.max === null || stats.medianDelta === null) return false;

  const normalized = normalizedHeader(header);
  const looksLikeSecondField =
    normalized.includes('timestamp_s') ||
    normalized === 'timestamp' ||
    normalized === 'timestamps' ||
    normalized === 'time_s' ||
    normalized === 'time';
  if (!looksLikeSecondField) return false;

  const rawRange = Math.abs(stats.max - stats.min);
  const medianDeltaAsSeconds = stats.medianDelta;
  const medianDeltaAsMilliseconds = stats.medianDelta * 0.001;
  return rawRange > 10_000 && medianDeltaAsSeconds > 1 && medianDeltaAsMilliseconds <= 10;
}

export function getTimeColumn(headers: string[], rows: string[][] = [], options?: AutomaticCheckOptions) {
  const normalizedHeaders = headers.map(normalizedHeader);
  const candidates: Array<TimeColumnDefinition & { index: number; rangeSeconds: number }> = [];
  const applyAutomaticChecks = automaticChecksEnabled(options);

  for (const definition of TIME_COLUMNS) {
    const index = normalizedHeaders.findIndex((header) => definition.names.includes(header));

    if (index >= 0) {
      const stats = rows.length > 0 ? timeColumnStats(rows, index) : null;
      const adjustedSecondsPerUnit =
        applyAutomaticChecks &&
        stats &&
        isLikelyMillisecondTimestamp(headers[index] ?? '', definition.relativeToFirstValue, definition.secondsPerUnit, stats)
          ? 0.001
          : definition.secondsPerUnit;
      const rangeSeconds =
        stats && stats.min !== null && stats.max !== null
          ? Math.abs(stats.max - stats.min) * adjustedSecondsPerUnit
          : 0;

      candidates.push({
        ...definition,
        secondsPerUnit: adjustedSecondsPerUnit,
        index,
        rangeSeconds
      });
    }
  }

  if (candidates.length === 0) return null;
  if (rows.length === 0) return candidates[0];

  return (
    candidates
      .filter((candidate) => candidate.rangeSeconds > 0.001)
      .sort((left, right) => right.rangeSeconds - left.rangeSeconds)[0] ?? candidates[0]
  );
}

export function buildXAxis(dataset: ImportedDataset, options?: AutomaticCheckOptions): TimeAxis {
  const timeColumn = getTimeColumn(dataset.headers, dataset.rows, options);

  if (!timeColumn) {
    return {
      values: dataset.rows.map((_, index) => index),
      title: 'Row',
      hoverLabel: 'row'
    };
  }

  const firstTimeValue =
    dataset.rows
      .map((row) => parseNumber(row[timeColumn.index]))
      .find((value) => value !== null) ?? 0;

  return {
    values: dataset.rows.map((row, index) => {
      const timeValue = parseNumber(row[timeColumn.index]);
      if (timeValue === null) {
        return index;
      }

      const relativeValue = timeColumn.relativeToFirstValue ? timeValue - firstTimeValue : timeValue;
      return relativeValue * timeColumn.secondsPerUnit;
    }),
    title: 'Time (s)',
    hoverLabel: 'time'
  };
}
