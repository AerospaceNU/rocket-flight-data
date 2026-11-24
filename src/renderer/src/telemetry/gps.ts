import type { GpsMapPoint } from '../GpsMapView';
import {
  autoDetectEnabled,
  getColumnIndexByAliases,
  isMeaningfulGpsCoordinate,
  isValidLatitude,
  isValidLongitude,
  parseNumber,
  type AutoDetectOptions
} from './core';

export type GpsPositionColumns = {
  latitudeIndex: number;
  longitudeIndex: number;
  /** Fix-quality column when the logger has one (0 = no fix: the receiver repeats its last position). */
  fixQualityIndex?: number | null;
};

export type GpsColumns = GpsPositionColumns & {
  altitudeIndex: number;
};

const FIX_QUALITY_ALIASES = ['gpsfixquality', 'gps_fix_quality', 'fix_quality', 'fixquality'];

/**
 * False only when the row says it has no fix. Without a fix, SeriousGoose keeps logging the last (pre-flight)
 * position, which would draw a flight that never moved, so those rows are not positions.
 */
export function rowHasGpsFix(row: string[], fixQualityIndex: number | null | undefined) {
  if (fixQualityIndex === null || fixQualityIndex === undefined) return true;
  const fixQuality = parseNumber(row[fixQualityIndex]);
  return fixQuality === null || fixQuality > 0;
}

function scoreGpsColumnPair(
  rows: string[][],
  latitudeIndex: number,
  longitudeIndex: number,
  fixQualityIndex: number | null
) {
  let validCount = 0;
  let meaningfulCount = 0;
  let localLookingCount = 0;

  for (const row of rows) {
    if (!rowHasGpsFix(row, fixQualityIndex)) {
      continue;
    }
    const latitude = parseNumber(row[latitudeIndex]);
    const longitude = parseNumber(row[longitudeIndex]);

    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
      continue;
    }

    validCount += 1;

    if (!isMeaningfulGpsCoordinate(latitude, longitude)) {
      continue;
    }

    meaningfulCount += 1;

    if (Math.abs(latitude) < 5 && Math.abs(longitude) < 5) {
      localLookingCount += 1;
    }
  }

  return { validCount, meaningfulCount, localLookingCount };
}

export function findGpsColumns(headers: string[], rows: string[][], options?: AutoDetectOptions): GpsPositionColumns | null {
  const pairs = [
    { latitudeAliases: ['latitude'], longitudeAliases: ['longitude'] },
    { latitudeAliases: ['lat'], longitudeAliases: ['lon', 'lng'] },
    { latitudeAliases: ['gps_lat'], longitudeAliases: ['gps_long'] },
    { latitudeAliases: ['gps_lat_mod'], longitudeAliases: ['gps_long_mod'] },
    { latitudeAliases: ['gpslatitudedeg'], longitudeAliases: ['gpslongitudedeg'] }
  ];

  const fixQualityIndex = getColumnIndexByAliases(headers, FIX_QUALITY_ALIASES);
  const candidates = pairs
    .map((pair, preferenceIndex) => {
      const latitudeIndex = getColumnIndexByAliases(headers, pair.latitudeAliases);
      const longitudeIndex = getColumnIndexByAliases(headers, pair.longitudeAliases);

      if (latitudeIndex === null || longitudeIndex === null) {
        return null;
      }

      return {
        latitudeIndex,
        longitudeIndex,
        preferenceIndex,
        ...scoreGpsColumnPair(rows, latitudeIndex, longitudeIndex, fixQualityIndex)
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .filter((candidate) => candidate.meaningfulCount > 0);

  if (candidates.length === 0) {
    return null;
  }

  if (autoDetectEnabled(options)) {
    candidates.sort((left, right) => {
      const leftLocalRatio = left.localLookingCount / left.meaningfulCount;
      const rightLocalRatio = right.localLookingCount / right.meaningfulCount;
      const leftIsMostlyLocal = leftLocalRatio > 0.95;
      const rightIsMostlyLocal = rightLocalRatio > 0.95;

      if (leftIsMostlyLocal !== rightIsMostlyLocal) {
        return leftIsMostlyLocal ? 1 : -1;
      }

      if (left.meaningfulCount !== right.meaningfulCount) {
        return right.meaningfulCount - left.meaningfulCount;
      }

      return left.preferenceIndex - right.preferenceIndex;
    });
  } else {
    candidates.sort((left, right) => left.preferenceIndex - right.preferenceIndex);
  }

  const best = candidates[0];
  return {
    latitudeIndex: best.latitudeIndex,
    longitudeIndex: best.longitudeIndex,
    fixQualityIndex
  };
}

export function findAltitudeIndex(headers: string[]) {
  return getColumnIndexByAliases(headers, ['altitude', 'altitude_m', 'altitudem', 'gps_alt', 'pos_z', 'height']);
}

export function buildGpsPoints(
  rows: string[][],
  xValues: number[],
  gpsColumns: GpsColumns,
  launchAltitude?: number
): GpsMapPoint[] {
  const baselineAltitude =
    launchAltitude ??
    rows.map((row) => parseNumber(row[gpsColumns.altitudeIndex])).find((value) => value !== null) ??
    0;

  return rows
    .map((row, index) => {
      const hasFix = rowHasGpsFix(row, gpsColumns.fixQualityIndex);
      return {
        latitude: hasFix ? parseNumber(row[gpsColumns.latitudeIndex]) : null,
        longitude: hasFix ? parseNumber(row[gpsColumns.longitudeIndex]) : null,
        altitude: parseNumber(row[gpsColumns.altitudeIndex]),
        time: xValues[index]
      };
    })
    .filter(
      (point): point is { latitude: number; longitude: number; altitude: number; time: number } =>
        point.latitude !== null &&
        point.longitude !== null &&
        point.altitude !== null &&
        isMeaningfulGpsCoordinate(point.latitude, point.longitude) &&
        Number.isFinite(point.time)
    )
    .map((point) => ({
      ...point,
      height: Math.max(0, point.altitude - baselineAltitude)
    }));
}
