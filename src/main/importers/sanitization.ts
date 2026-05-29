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

export function emptySanitizationSummary(): SanitizationSummary {
  return {
    rowsRemoved: 0,
    gpsValuesBlanked: 0,
    numericValuesBlanked: 0,
    stateValuesBlanked: 0
  };
}

function parseNumber(value: string | undefined) {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : null;
}

function getColumnIndex(headers: string[], column: string) {
  const index = headers.indexOf(column);
  return index >= 0 ? index : null;
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

function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
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
