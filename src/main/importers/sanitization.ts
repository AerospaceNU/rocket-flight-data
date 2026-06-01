import { getColumnIndex, median, parseNumber } from '../../shared/telemetryMath';

export type SanitizationSummary = {
  rowsRemoved: number;
  gpsValuesBlanked: number;
  numericValuesBlanked: number;
  stateValuesBlanked: number;
};

export type NumericRangeRule = {
  column: string;
  min?: number;
  max?: number;
};

export type StateColumnRule = {
  column: string;
  allowedStates: ReadonlySet<number>;
  stateNameColumn?: string | null;
};

export type GpsColumnRule = {
  latitudeColumn: string;
  longitudeColumn: string;
};

/**
 * Declarative sanitization rules for one importer. Keep each importer's rules in
 * its own module (see fcbgroundstationSanitizer.ts for the canonical example);
 * an empty config is a no-op so importers with clean data add no behavior.
 */
export type SanitizationConfig = {
  state?: StateColumnRule;
  numericRanges?: NumericRangeRule[];
  gps?: GpsColumnRule;
};

export type SanitizationResult = {
  rows: string[][];
  summary: SanitizationSummary;
};

/**
 * Apply a SanitizationConfig to a copy of the rows. When `enabled` is false the
 * rows are copied through untouched. Returns the (possibly cleaned) rows plus a
 * summary of what was blanked.
 */
export function sanitizeRows(
  headers: string[],
  rows: string[][],
  config: SanitizationConfig,
  enabled: boolean
): SanitizationResult {
  const summary = emptySanitizationSummary();
  const hasRules = Boolean(
    config.state || (config.numericRanges && config.numericRanges.length > 0) || config.gps
  );

  // Nothing to do: hand the rows back untouched (no defensive copy needed).
  if (!enabled || !hasRules) {
    return { rows, summary };
  }

  const nextRows = rows.map((row) => [...row]);

  if (config.state) {
    sanitizeStateColumn(
      headers,
      nextRows,
      config.state.column,
      config.state.allowedStates,
      config.state.stateNameColumn ?? null,
      summary
    );
  }
  if (config.numericRanges && config.numericRanges.length > 0) {
    sanitizeNumericRanges(headers, nextRows, config.numericRanges, summary);
  }
  if (config.gps) {
    sanitizeGpsColumns(headers, nextRows, config.gps.latitudeColumn, config.gps.longitudeColumn, summary);
  }

  return { rows: nextRows, summary };
}

export function emptySanitizationSummary(): SanitizationSummary {
  return {
    rowsRemoved: 0,
    gpsValuesBlanked: 0,
    numericValuesBlanked: 0,
    stateValuesBlanked: 0
  };
}

function blankCell(row: string[], index: number) {
  if (row[index] === '') {
    return false;
  }

  row[index] = '';
  return true;
}

export function sanitizeNumericRanges(
  headers: string[],
  rows: string[][],
  rules: NumericRangeRule[],
  summary: SanitizationSummary
) {
  const indexedRules = rules
    .map((rule) => ({ ...rule, index: getColumnIndex(headers, rule.column) }))
    .filter((rule): rule is NumericRangeRule & { index: number } => rule.index !== null);

  for (const row of rows) {
    for (const rule of indexedRules) {
      const raw = row[rule.index];
      if (raw === undefined || raw === '') {
        continue;
      }

      const value = parseNumber(raw);
      const outOfRange =
        value === null ||
        (rule.min !== undefined && value < rule.min) ||
        (rule.max !== undefined && value > rule.max);

      if (outOfRange && blankCell(row, rule.index)) {
        summary.numericValuesBlanked += 1;
      }
    }
  }
}

export function sanitizeStateColumn(
  headers: string[],
  rows: string[][],
  stateColumn: string,
  allowedStates: ReadonlySet<number>,
  stateNameColumn: string | null,
  summary: SanitizationSummary
) {
  const stateIndex = getColumnIndex(headers, stateColumn);
  const stateNameIndex = stateNameColumn ? getColumnIndex(headers, stateNameColumn) : null;
  if (stateIndex === null) {
    return;
  }

  for (const row of rows) {
    const value = parseNumber(row[stateIndex]);
    if (value === null || !Number.isInteger(value) || !allowedStates.has(value)) {
      if (blankCell(row, stateIndex)) {
        summary.stateValuesBlanked += 1;
      }
      if (stateNameIndex !== null) {
        blankCell(row, stateNameIndex);
      }
    }
  }
}

function isValidCoordinate(latitude: number | null, longitude: number | null) {
  return (
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    Math.abs(latitude) > 0.001 &&
    Math.abs(longitude) > 0.001
  );
}

export function sanitizeGpsColumns(
  headers: string[],
  rows: string[][],
  latitudeColumn: string,
  longitudeColumn: string,
  summary: SanitizationSummary
) {
  const latitudeIndex = getColumnIndex(headers, latitudeColumn);
  const longitudeIndex = getColumnIndex(headers, longitudeColumn);
  if (latitudeIndex === null || longitudeIndex === null) {
    return;
  }

  const validCoordinates = rows
    .map((row) => ({
      latitude: parseNumber(row[latitudeIndex]),
      longitude: parseNumber(row[longitudeIndex])
    }))
    .filter((point): point is { latitude: number; longitude: number } =>
      isValidCoordinate(point.latitude, point.longitude)
    );

  const baselineLatitude = median(validCoordinates.slice(0, 250).map((point) => point.latitude));
  const baselineLongitude = median(validCoordinates.slice(0, 250).map((point) => point.longitude));

  for (const row of rows) {
    const latitude = parseNumber(row[latitudeIndex]);
    const longitude = parseNumber(row[longitudeIndex]);
    const valid = isValidCoordinate(latitude, longitude);
    let outlier = false;
    if (
      valid &&
      latitude !== null &&
      longitude !== null &&
      baselineLatitude !== null &&
      baselineLongitude !== null
    ) {
      outlier =
        Math.abs(latitude - baselineLatitude) > 1 ||
        Math.abs(longitude - baselineLongitude) > 1;
    }

    if (!valid || outlier) {
      if (blankCell(row, latitudeIndex)) {
        summary.gpsValuesBlanked += 1;
      }
      if (blankCell(row, longitudeIndex)) {
        summary.gpsValuesBlanked += 1;
      }
    }
  }
}

export function countValidGpsRows(headers: string[], rows: string[][], latitudeColumn: string, longitudeColumn: string) {
  const latitudeIndex = getColumnIndex(headers, latitudeColumn);
  const longitudeIndex = getColumnIndex(headers, longitudeColumn);
  if (latitudeIndex === null || longitudeIndex === null) {
    return 0;
  }

  return rows.filter((row) =>
    isValidCoordinate(parseNumber(row[latitudeIndex]), parseNumber(row[longitudeIndex]))
  ).length;
}

export function applySanitizationAttributes(
  attributes: Record<string, string>,
  summary: SanitizationSummary,
  enabled: boolean
) {
  attributes.sanitized_source = enabled ? 'true' : 'false';
  attributes.bad_rows_removed = String(summary.rowsRemoved);
  attributes.bad_gps_values_blanked = String(summary.gpsValuesBlanked);
  attributes.bad_numeric_values_blanked = String(summary.numericValuesBlanked);
  attributes.bad_state_values_blanked = String(summary.stateValuesBlanked);
}
