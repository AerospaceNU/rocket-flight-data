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
};

export type GpsColumns = GpsPositionColumns & {
  altitudeIndex: number;
};

function scoreGpsColumnPair(rows: string[][], latitudeIndex: number, longitudeIndex: number) {
  let validCount = 0;
  let meaningfulCount = 0;
  let localLookingCount = 0;

  for (const row of rows) {
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
    { latitudeAliases: ['gps_lat_mod'], longitudeAliases: ['gps_long_mod'] }
  ];

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
        ...scoreGpsColumnPair(rows, latitudeIndex, longitudeIndex)
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
    longitudeIndex: best.longitudeIndex
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
    .map((row, index) => ({
      latitude: parseNumber(row[gpsColumns.latitudeIndex]),
      longitude: parseNumber(row[gpsColumns.longitudeIndex]),
      altitude: parseNumber(row[gpsColumns.altitudeIndex]),
      time: xValues[index]
    }))
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
