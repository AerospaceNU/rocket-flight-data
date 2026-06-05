import type { ImportedDataset } from '../importTypes';
import {
  autoDetectEnabled,
  normalizedHeader,
  parseNumber,
  type AutoDetectOptions
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
  let numericCount = 0;
  let fractionalCount = 0;
  const deltas: number[] = [];

  for (const row of rows) {
    const raw = row[columnIndex];
    const value = parseNumber(raw);
    if (value === null) continue;
    numericCount += 1;
    if (raw?.includes('.') && Math.abs(value - Math.trunc(value)) > 1e-9) {
      fractionalCount += 1;
    }
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

  return { first, min, max, medianDelta, numericCount, fractionalCount };
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

function isLikelySecondTimestampInMillisecondField(
  header: string,
  secondsPerUnit: number,
  stats: {
    min: number | null;
    max: number | null;
    medianDelta: number | null;
    numericCount: number;
    fractionalCount: number;
  }
) {
  if (secondsPerUnit !== 0.001) return false;
  if (stats.min === null || stats.max === null || stats.medianDelta === null) return false;

  const normalized = normalizedHeader(header);
  const looksLikeMillisecondField =
    normalized.includes('timestamp_ms') ||
    normalized.includes('timestampms') ||
    normalized.includes('time_ms') ||
    normalized.includes('timems');
  if (!looksLikeMillisecondField) return false;

  const rawRange = Math.abs(stats.max - stats.min);
  const rangeIfMilliseconds = rawRange * 0.001;
  const rangeIfSeconds = rawRange;
  const fractionalRatio = stats.numericCount > 0 ? stats.fractionalCount / stats.numericCount : 0;

  return (
    rangeIfMilliseconds < 5 &&
    rangeIfSeconds >= 5 &&
    (fractionalRatio > 0.05 || stats.medianDelta < 5)
  );
}

export function getTimeColumn(headers: string[], rows: string[][] = [], options?: AutoDetectOptions) {
  const normalizedHeaders = headers.map(normalizedHeader);
  const candidates: Array<TimeColumnDefinition & { index: number; rangeSeconds: number }> = [];
  const applyAutoDetect = autoDetectEnabled(options);

  for (const definition of TIME_COLUMNS) {
    const index = normalizedHeaders.findIndex((header) => definition.names.includes(header));

    if (index >= 0) {
      const stats = rows.length > 0 ? timeColumnStats(rows, index) : null;
      let adjustedSecondsPerUnit = definition.secondsPerUnit;
      if (applyAutoDetect && stats) {
        if (
          isLikelyMillisecondTimestamp(
            headers[index] ?? '',
            definition.relativeToFirstValue,
            definition.secondsPerUnit,
            stats
          )
        ) {
          adjustedSecondsPerUnit = 0.001;
        } else if (
          isLikelySecondTimestampInMillisecondField(
            headers[index] ?? '',
            definition.secondsPerUnit,
            stats
          )
        ) {
          adjustedSecondsPerUnit = 1;
        }
      }
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

export function buildXAxis(dataset: ImportedDataset, options?: AutoDetectOptions): TimeAxis {
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
    title: 'Time(s)',
    hoverLabel: 'time'
  };
}
