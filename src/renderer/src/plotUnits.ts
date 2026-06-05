import type { ColumnUnitMap, DisplayUnitSystem } from '../../shared/units';
import {
  convertDisplayValue,
  displayUnitLabel
} from '../../shared/units';
import { parseNumber } from './telemetry/core';

export function parseDisplaySeriesValue(
  rawValue: string | undefined,
  header: string,
  columnUnits: ColumnUnitMap,
  displayUnits: DisplayUnitSystem
) {
  const value = parseNumber(rawValue);
  if (value === null) return Number.NaN;
  return convertDisplayValue(value, columnUnits[header], displayUnits);
}

export function seriesDisplayLabel(
  label: string,
  header: string,
  columnUnits: ColumnUnitMap,
  displayUnits: DisplayUnitSystem
) {
  const unit = displayUnitLabel(columnUnits[header], displayUnits);
  return unit ? `${label} (${unit})` : label;
}

export function yAxisTitleForSeries(
  headers: string[],
  columnUnits: ColumnUnitMap,
  displayUnits: DisplayUnitSystem
) {
  const units = Array.from(
    new Set(
      headers
        .map((header) => displayUnitLabel(columnUnits[header], displayUnits))
        .filter((unit) => unit.length > 0)
    )
  );

  if (units.length === 0) return 'Value';
  if (units.length === 1) return `Value (${units[0]})`;
  return 'Value (mixed units)';
}
