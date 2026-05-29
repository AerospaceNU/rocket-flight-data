import { useEffect, useMemo, useRef, useState } from 'react';
import Plotly2D from 'plotly.js-basic-dist-min';
import Plotly3D from 'plotly.js-gl3d-dist-min';
import { model as geomagneticModel } from 'geomagnetism';
import { AttributeEditor, ensureRequiredAttributes, hasRequiredAttributes } from './AttributeEditor';
import { FcbRocketReplayMap, type RocketPosePoint } from './FcbRocketReplayMap';
import { GpsMapView, type GpsEventMarker, type GpsMapPoint } from './GpsMapView';
import type {
  CustomAttribute,
  FlightSummary,
  ImportConfig,
  ImportedDataset,
  StandardColumnMapping
} from './importTypes';

const REQUIRED_ATTRIBUTE_KEYS = ['motor'];
const MULTILINE_ATTRIBUTE_KEYS = ['flight_notes'];
const ENSURED_ATTRIBUTE_KEYS = [...REQUIRED_ATTRIBUTE_KEYS, ...MULTILINE_ATTRIBUTE_KEYS];

type FlightViewerProps = {
  config: ImportConfig | null;
  flight: FlightSummary | null;
  isActive: boolean;
  selectedAltimeterDirectory?: string;
  onDatasetUpdated: () => Promise<FlightSummary[]>;
};

type ViewerSection = 'attributes' | 'plot2d' | 'plot3d' | 'map2d' | 'map3d' | 'rocketReplay' | 'raw';

type EventMarker = {
  label: string;
  time: number;
  rowIndex: number;
  color: string;
};

type FlightEventMarker = EventMarker & {
  canonicalLabel: string;
  sourceImporterId: string;
  sourceLabel: string;
  priority: number;
};

type PlotHoverPoint = {
  x: number | string;
  y: number;
  data: {
    name?: string;
  };
};

type PlotHoverEvent = {
  points?: PlotHoverPoint[];
};

type PlotElement = HTMLElement & {
  on?: (eventName: string, callback: (event: PlotHoverEvent) => void) => void;
  removeAllListeners?: (eventName: string) => void;
};

const PAGE_SIZE = 250;
const FLIGHT_STATE_NAMES: Record<number, string> = {
  0: 'PRE_FLIGHT',
  1: 'ASCENT',
  2: 'DESCENT',
  3: 'POST_FLIGHT'
};
const EASYMINI_STATE_NAMES: Record<number, string> = {
  3: 'boost',
  5: 'coast',
  6: 'drogue',
  7: 'main',
  8: 'landed'
};
// stm32-avionics StateId_e (common/system/scheduler.h)
const FCB_STATE_NAMES: Record<number, string> = {
  0: 'CliEraseFlash',
  1: 'CliOffload',
  2: 'Ascent',
  3: 'Descent',
  4: 'Initialize',
  5: 'PostFlight',
  6: 'PreFlight',
  7: 'SimTempState'
};
const FCB_LAUNCH_STATE = 2;
const FCB_END_STATE = 5;
const MAX_EVENT_MARKERS = 200;
const EVENT_SOURCE_PRIORITY: Record<string, number> = {
  fcb: 4,
  fcbgroundstation: 4,
  sillygoose: 3,
  easymini: 2,
  stratologgercf: 1
};

function defaultSeries(
  headers: string[],
  timeColumnIndex: number | null,
  standardColumns: StandardColumnMapping | null
) {
  const preferred = standardColumns
    ? [
        standardColumns.altitudeMeters?.column,
        standardColumns.velocityMetersPerSecond?.column,
        standardColumns.accelerationMetersPerSecondSquared?.column
      ].filter((column): column is string => Boolean(column))
    : [];
  const indexes = preferred
    .map((name) => headers.indexOf(name))
    .filter((index) => index > 0 && index !== timeColumnIndex);

  return indexes.length > 0
    ? indexes
    : headers
        .map((_, index) => index)
        .filter((index) => index > 0 && index !== timeColumnIndex)
        .slice(0, 3);
}

function parseNumber(value: string | undefined) {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : null;
}

function getColumnIndex(headers: string[], name: string) {
  const index = headers.indexOf(name);
  return index >= 0 ? index : null;
}

type TimeColumnDefinition = {
  names: string[];
  secondsPerUnit: number;
  relativeToFirstValue: boolean;
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

function normalizedHeader(header: string) {
  return header.trim().toLowerCase();
}

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
  stats: { first: number | null; min: number | null; max: number | null; medianDelta: number | null }
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

function getTimeColumn(headers: string[], rows: string[][] = []) {
  const normalizedHeaders = headers.map(normalizedHeader);
  const candidates: Array<TimeColumnDefinition & { index: number; rangeSeconds: number }> = [];

  for (const definition of TIME_COLUMNS) {
    const index = normalizedHeaders.findIndex((header) => definition.names.includes(header));

    if (index >= 0) {
      const stats = rows.length > 0 ? timeColumnStats(rows, index) : null;
      const adjustedSecondsPerUnit =
        stats && isLikelyMillisecondTimestamp(headers[index] ?? '', definition.relativeToFirstValue, definition.secondsPerUnit, stats)
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

function buildXAxis(dataset: ImportedDataset) {
  const timeColumn = getTimeColumn(dataset.headers, dataset.rows);

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

function buildEventMarkers(dataset: ImportedDataset, xValues: number[]) {
  const attributes = dataset.attributes.reduce<Record<string, string>>((record, attribute) => {
    record[attribute.key] = attribute.value;
    return record;
  }, {});
  const importerId = attributes.importer_id ?? '';
  const isFcbGroundStation = importerId === 'fcbgroundstation';
  const isFcb = importerId === 'fcb';

  const flightStateIndex = isFcb || isFcbGroundStation ? null : getColumnIndex(dataset.headers, 'flightState');
  const fcbStateIndex = isFcb ? getColumnIndex(dataset.headers, 'state') : null;
  const easyMiniStateIndex =
    isFcb || isFcbGroundStation || flightStateIndex !== null ? null : getColumnIndex(dataset.headers, 'state');
  const stateIndex = flightStateIndex ?? fcbStateIndex ?? easyMiniStateIndex;
  const stateNameIndex = getColumnIndex(dataset.headers, 'state_name');
  const drogueFiredIndex = getColumnIndex(dataset.headers, 'drogueFired');
  const mainFiredIndex = getColumnIndex(dataset.headers, 'mainFired');
  const events: EventMarker[] = [];
  let launchTime: number | null = null;
  let flightEndTime: number | null = null;

  for (let index = 1; index < dataset.rows.length; index += 1) {
    if (stateIndex !== null) {
      const previousState = Number.parseInt(dataset.rows[index - 1]?.[stateIndex] ?? '', 10);
      const currentState = Number.parseInt(dataset.rows[index]?.[stateIndex] ?? '', 10);

      if (Number.isFinite(previousState) && Number.isFinite(currentState) && previousState !== currentState) {
        const stateNames =
          flightStateIndex !== null
            ? FLIGHT_STATE_NAMES
            : fcbStateIndex !== null
              ? FCB_STATE_NAMES
              : EASYMINI_STATE_NAMES;
        const previousName =
          stateNameIndex !== null
            ? dataset.rows[index - 1]?.[stateNameIndex]
            : stateNames[previousState];
        const currentName =
          stateNameIndex !== null
            ? dataset.rows[index]?.[stateNameIndex]
            : stateNames[currentState];
        const hasKnownState =
          Boolean(previousName) || Boolean(currentName) || stateNameIndex !== null;

        if (hasKnownState) {
          events.push({
            label: `${previousName ?? previousState} -> ${currentName ?? currentState}`,
            time: xValues[index],
            rowIndex: index,
            color: '#74c69d'
          });
        }

        if (
          hasKnownState &&
          launchTime === null &&
          ((flightStateIndex !== null && previousState === 0 && currentState !== 0) ||
            (fcbStateIndex !== null && currentState === FCB_LAUNCH_STATE) ||
            (easyMiniStateIndex !== null && currentState === 5))
        ) {
          launchTime = xValues[index];
        }

        if (
          hasKnownState &&
          ((flightStateIndex !== null && currentState === 3) ||
            (fcbStateIndex !== null && currentState === FCB_END_STATE) ||
            (easyMiniStateIndex !== null && currentState === 8))
        ) {
          flightEndTime = xValues[index];
        }
      }
    }

    if (
      drogueFiredIndex !== null &&
      dataset.rows[index - 1]?.[drogueFiredIndex] === '0' &&
      dataset.rows[index]?.[drogueFiredIndex] === '1'
    ) {
      events.push({
        label: 'DROGUE FIRED',
        time: xValues[index],
        rowIndex: index,
        color: '#b07cff'
      });
    }

    if (
      mainFiredIndex !== null &&
      dataset.rows[index - 1]?.[mainFiredIndex] === '0' &&
      dataset.rows[index]?.[mainFiredIndex] === '1'
    ) {
      events.push({
        label: 'MAIN FIRED',
        time: xValues[index],
        rowIndex: index,
        color: '#69a7ff'
      });
    }
  }

  const drogueAt = parseNumber(attributes.drogue_at?.replace(/[^0-9.+-]/g, ''));
  const mainAt = parseNumber(attributes.main_at?.replace(/[^0-9.+-]/g, ''));

  if (drogueAt !== null) {
    events.push({
      label: 'DROGUE',
      time: drogueAt,
      rowIndex: xValues.findIndex((time) => time >= drogueAt),
      color: '#b07cff'
    });
  }

  if (mainAt !== null) {
    events.push({
      label: 'MAIN',
      time: mainAt,
      rowIndex: xValues.findIndex((time) => time >= mainAt),
      color: '#69a7ff'
    });
  }

  const sortedEvents = events
    .sort((left, right) => left.time - right.time)
    .slice(0, MAX_EVENT_MARKERS);
  const firstEventTime = sortedEvents[0]?.time ?? xValues[0] ?? 0;
  const lastEventTime = sortedEvents[sortedEvents.length - 1]?.time ?? xValues[xValues.length - 1] ?? 0;

  return {
    events: sortedEvents,
    launchTime,
    flightStartTime: launchTime ?? firstEventTime,
    flightEndTime: flightEndTime ?? lastEventTime
  };
}

function buildWindow(xValues: number[], flightStartTime: number, flightEndTime: number) {
  const minTime = xValues[0] ?? 0;
  const maxTime = xValues[xValues.length - 1] ?? minTime;

  return {
    start: Math.max(minTime, flightStartTime - 20),
    end: Math.min(maxTime, flightEndTime + 20)
  };
}

function axisRange(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  return Math.max(0, max - min);
}

function getColumnIndexByAliases(headers: string[], aliases: string[]) {
  const normalizedHeaders = headers.map(normalizedHeader);

  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(alias.toLowerCase());
    if (index >= 0) {
      return index;
    }
  }

  return null;
}

function isValidLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

function scoreGpsColumnPair(rows: string[][], latitudeIndex: number, longitudeIndex: number) {
  let validCount = 0;
  let localLookingCount = 0;

  for (const row of rows) {
    const latitude = parseNumber(row[latitudeIndex]);
    const longitude = parseNumber(row[longitudeIndex]);

    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
      continue;
    }

    validCount += 1;

    if (Math.abs(latitude) < 5 && Math.abs(longitude) < 5) {
      localLookingCount += 1;
    }
  }

  return { validCount, localLookingCount };
}

function findGpsColumns(headers: string[], rows: string[][]) {
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
    .filter((candidate) => candidate.validCount > 0);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftLocalRatio = left.localLookingCount / left.validCount;
    const rightLocalRatio = right.localLookingCount / right.validCount;
    const leftIsMostlyLocal = leftLocalRatio > 0.95;
    const rightIsMostlyLocal = rightLocalRatio > 0.95;

    if (leftIsMostlyLocal !== rightIsMostlyLocal) {
      return leftIsMostlyLocal ? 1 : -1;
    }

    if (left.validCount !== right.validCount) {
      return right.validCount - left.validCount;
    }

    return left.preferenceIndex - right.preferenceIndex;
  });

  const best = candidates[0];
  return {
    latitudeIndex: best.latitudeIndex,
    longitudeIndex: best.longitudeIndex
  };
}

function normalizeQuaternion(x: number, y: number, z: number, w: number) {
  const magnitude = Math.hypot(x, y, z, w);
  if (!Number.isFinite(magnitude) || magnitude < 1e-9) {
    return null;
  }

  return {
    qX: x / magnitude,
    qY: y / magnitude,
    qZ: z / magnitude,
    qW: w / magnitude
  };
}

type QuaternionColumns = {
  qxIndex: number;
  qyIndex: number;
  qzIndex: number;
  qwIndex: number;
};

type MagnetometerColumns = {
  xIndex: number;
  yIndex: number;
  zIndex: number;
};

function normalizeDegrees(degrees: number) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function bearingDegrees(east: number, north: number) {
  return (Math.atan2(east, north) * 180) / Math.PI;
}

function rotateVectorByQuaternion(
  quaternion: NonNullable<ReturnType<typeof normalizeQuaternion>>,
  vector: [number, number, number]
) {
  const { qX: x, qY: y, qZ: z, qW: w } = quaternion;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);

  return [
    r00 * vector[0] + r01 * vector[1] + r02 * vector[2],
    r10 * vector[0] + r11 * vector[1] + r12 * vector[2],
    r20 * vector[0] + r21 * vector[1] + r22 * vector[2]
  ];
}

function getMagnetometerColumns(headers: string[]): MagnetometerColumns | null {
  const xIndex = getColumnIndexByAliases(headers, [
    'imu_mag_x_avg',
    'imu1_mag_x_real',
    'imu2_mag_x_real',
    'imu1_mag_x',
    'imu2_mag_x',
    'mag_x',
    'magnetometer_x'
  ]);
  const yIndex = getColumnIndexByAliases(headers, [
    'imu_mag_y_avg',
    'imu1_mag_y_real',
    'imu2_mag_y_real',
    'imu1_mag_y',
    'imu2_mag_y',
    'mag_y',
    'magnetometer_y'
  ]);
  const zIndex = getColumnIndexByAliases(headers, [
    'imu_mag_z_avg',
    'imu1_mag_z_real',
    'imu2_mag_z_real',
    'imu1_mag_z',
    'imu2_mag_z',
    'mag_z',
    'magnetometer_z'
  ]);

  if (xIndex === null || yIndex === null || zIndex === null) {
    return null;
  }

  return { xIndex, yIndex, zIndex };
}

function flightDateForGeomagneticModel(dataset: ImportedDataset) {
  const dateText =
    dataset.summary.flightDate ||
    dataset.attributes.find((attribute) => attribute.key === 'flight_date')?.value ||
    dataset.summary.flightDirectoryName.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
    '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T12:00:00Z`) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function magneticDeclinationDegrees(latitude: number, longitude: number, altitudeMeters: number, date: Date) {
  try {
    const model = geomagneticModel(date, { allowOutOfBoundsModel: true });
    const point = model.point([latitude, longitude, altitudeMeters / 1000]);
    return Number.isFinite(point.decl) ? point.decl : 0;
  } catch {
    return 0;
  }
}

function calibrationIndexes(xValues: number[]) {
  const preLaunch = xValues
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => Number.isFinite(time) && time >= -20 && time <= -0.25)
    .map(({ index }) => index);

  if (preLaunch.length >= 8) {
    return preLaunch;
  }

  const firstTime = xValues.find((time) => Number.isFinite(time)) ?? 0;
  return xValues
    .map((time, index) => ({ time, index }))
    .filter(({ time }) => Number.isFinite(time) && time >= firstTime && time <= firstTime + 20)
    .map(({ index }) => index);
}

function computeNorthAlignmentDegrees(
  dataset: ImportedDataset,
  xValues: number[],
  gpsColumns: { latitudeIndex: number; longitudeIndex: number; altitudeIndex: number },
  quaternionColumns: QuaternionColumns
) {
  const magColumns = getMagnetometerColumns(dataset.headers);
  if (!magColumns || dataset.rows.length === 0 || xValues.length !== dataset.rows.length) {
    return 0;
  }

  const indexes = calibrationIndexes(xValues);
  if (indexes.length === 0) {
    return 0;
  }

  const stride = Math.max(1, Math.ceil(indexes.length / 600));
  let eastSum = 0;
  let northSum = 0;
  let usedSamples = 0;
  let calibrationLatitude: number | null = null;
  let calibrationLongitude: number | null = null;
  let calibrationAltitude = 0;

  for (let position = 0; position < indexes.length; position += stride) {
    const row = dataset.rows[indexes[position]];
    const qx = parseNumber(row[quaternionColumns.qxIndex]);
    const qy = parseNumber(row[quaternionColumns.qyIndex]);
    const qz = parseNumber(row[quaternionColumns.qzIndex]);
    const qw = parseNumber(row[quaternionColumns.qwIndex]);
    const magX = parseNumber(row[magColumns.xIndex]);
    const magY = parseNumber(row[magColumns.yIndex]);
    const magZ = parseNumber(row[magColumns.zIndex]);

    if (qx === null || qy === null || qz === null || qw === null || magX === null || magY === null || magZ === null) {
      continue;
    }

    const quaternion = normalizeQuaternion(qx, qy, qz, qw);
    if (!quaternion) {
      continue;
    }

    const worldMag = rotateVectorByQuaternion(quaternion, [magX, magY, magZ]);
    const horizontalMagnitude = Math.hypot(worldMag[0], worldMag[1]);
    if (!Number.isFinite(horizontalMagnitude) || horizontalMagnitude < 1e-9) {
      continue;
    }

    eastSum += worldMag[0] / horizontalMagnitude;
    northSum += worldMag[1] / horizontalMagnitude;
    usedSamples += 1;

    if (calibrationLatitude === null || calibrationLongitude === null) {
      const latitude = parseNumber(row[gpsColumns.latitudeIndex]);
      const longitude = parseNumber(row[gpsColumns.longitudeIndex]);
      const altitude = parseNumber(row[gpsColumns.altitudeIndex]);
      if (isValidLatitude(latitude) && isValidLongitude(longitude)) {
        calibrationLatitude = latitude;
        calibrationLongitude = longitude;
        calibrationAltitude = altitude ?? 0;
      }
    }
  }

  if (usedSamples < 3 || calibrationLatitude === null || calibrationLongitude === null) {
    return 0;
  }

  const measuredMagneticBearing = bearingDegrees(eastSum / usedSamples, northSum / usedSamples);
  const declination = magneticDeclinationDegrees(
    calibrationLatitude,
    calibrationLongitude,
    calibrationAltitude,
    flightDateForGeomagneticModel(dataset)
  );

  return normalizeDegrees(declination - measuredMagneticBearing);
}

function estimateGpsLaunchTime(
  rows: string[][],
  xValues: number[],
  altitudeIndex: number,
  velocityIndex: number | null = null
): number | null {
  if (rows.length < 5 || xValues.length !== rows.length) {
    return null;
  }

  const altitudes = rows.map((row) => parseNumber(row[altitudeIndex]));
  const velocities = velocityIndex === null ? null : rows.map((row) => parseNumber(row[velocityIndex]));
  const baselineSample = altitudes
    .slice(0, Math.min(30, Math.max(5, Math.floor(altitudes.length * 0.1))))
    .filter((value): value is number => value !== null);

  if (baselineSample.length < 5) {
    return null;
  }

  const sortedBaseline = [...baselineSample].sort((left, right) => left - right);
  const baseline = sortedBaseline[Math.floor(sortedBaseline.length / 2)] ?? baselineSample[0];

  if (velocities) {
    for (let index = 0; index < altitudes.length; index += 1) {
      const altitude = altitudes[index];
      const velocity = velocities[index];
      if (altitude === null || velocity === null || altitude < baseline + 0.25 || velocity < 5) {
        continue;
      }

      const lookaheadEnd = Math.min(index + 7, altitudes.length);
      let sustainedCount = 0;
      let lastAltitude: number | null = null;

      for (let lookahead = index; lookahead < lookaheadEnd; lookahead += 1) {
        const nextAltitude = altitudes[lookahead];
        const nextVelocity = velocities[lookahead];
        if (nextAltitude !== null) {
          lastAltitude = nextAltitude;
        }
        if (nextAltitude !== null && nextVelocity !== null && nextAltitude >= baseline + 0.25 && nextVelocity > 2) {
          sustainedCount += 1;
        }
      }

      if (sustainedCount >= 4 && lastAltitude !== null && lastAltitude >= baseline + 8) {
        return xValues[index] ?? null;
      }
    }
  }

  const threshold = baseline + 15;

  for (let index = 0; index < altitudes.length; index += 1) {
    const altitude = altitudes[index];
    if (altitude === null || altitude < threshold) {
      continue;
    }

    const nextAltitudes = altitudes
      .slice(index, Math.min(index + 4, altitudes.length))
      .filter((value): value is number => value !== null);

    if (nextAltitudes.length >= 3 && nextAltitudes.every((value) => value >= baseline + 10)) {
      return xValues[index] ?? null;
    }
  }

  return null;
}

function getImporterId(dataset: ImportedDataset) {
  return dataset.attributes.find((attribute) => attribute.key === 'importer_id')?.value ??
    dataset.summary.attributes.importer_id ??
    '';
}

function isEventSourceImporter(importerId: string) {
  return importerId in EVENT_SOURCE_PRIORITY;
}

function normalizeEventLabel(label: string) {
  const normalized = label.trim().toUpperCase();
  if (normalized.includes('DROGUE')) return 'DROGUE';
  if (normalized.includes('MAIN')) return 'MAIN';
  if (normalized.includes('LAND') || normalized.includes('POST_FLIGHT')) return 'LANDING';
  if (normalized.includes('COAST')) return 'COAST';
  if (normalized.includes('BOOST')) return 'BOOST';
  if (normalized.includes('ASCENT')) return 'ASCENT';
  if (normalized.includes('DESCENT')) return 'DESCENT';
  return normalized;
}

function relativeEventMarkers(dataset: ImportedDataset): FlightEventMarker[] {
  const rawXAxis = buildXAxis(dataset);
  const rawEventData = buildEventMarkers(dataset, rawXAxis.values);
  const launchOffset = rawEventData.launchTime ?? 0;
  const importerId = getImporterId(dataset);
  const priority = EVENT_SOURCE_PRIORITY[importerId] ?? 0;
  const sourceLabel = dataset.summary.altimeterDirectoryName;

  return rawEventData.events.map((event) => ({
    ...event,
    time: event.time - launchOffset,
    canonicalLabel: normalizeEventLabel(event.label),
    sourceImporterId: importerId,
    sourceLabel,
    priority
  }));
}

function interpolateGpsPoint(points: GpsMapPoint[], targetTime: number): GpsMapPoint | null {
  if (points.length === 0) return null;
  if (targetTime < points[0].time || targetTime > points[points.length - 1].time) {
    return null;
  }

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    if (Math.abs(current.time - targetTime) < 1e-6) {
      return current;
    }

    const next = points[index + 1];
    if (!next) {
      return current;
    }

    if (targetTime > current.time && targetTime < next.time) {
      const span = next.time - current.time;
      if (span <= 0) {
        return current;
      }
      const ratio = (targetTime - current.time) / span;
      return {
        latitude: current.latitude + (next.latitude - current.latitude) * ratio,
        longitude: current.longitude + (next.longitude - current.longitude) * ratio,
        altitude: current.altitude + (next.altitude - current.altitude) * ratio,
        height: current.height + (next.height - current.height) * ratio,
        time: targetTime
      };
    }
  }

  return points[points.length - 1] ?? null;
}

function dedupeFlightEventMarkers(markers: FlightEventMarker[]) {
  const deduped: FlightEventMarker[] = [];

  for (const marker of markers.sort((left, right) => left.time - right.time || right.priority - left.priority)) {
    const existingIndex = deduped.findIndex(
      (candidate) =>
        candidate.canonicalLabel === marker.canonicalLabel && Math.abs(candidate.time - marker.time) <= 1.5
    );

    if (existingIndex < 0) {
      deduped.push(marker);
      continue;
    }

    const existing = deduped[existingIndex];
    if (
      marker.priority > existing.priority ||
      (marker.priority === existing.priority && marker.sourceLabel < existing.sourceLabel)
    ) {
      deduped[existingIndex] = marker;
    }
  }

  return deduped.slice(0, MAX_EVENT_MARKERS);
}

function eventColorForLabel(label: string): [number, number, number, number] {
  if (label === 'DROGUE') return [176, 124, 255, 245];
  if (label === 'MAIN') return [105, 167, 255, 245];
  if (label === 'LANDING') return [255, 110, 110, 245];
  return [255, 191, 102, 240];
}

function buildGpsEventMarkers(points: GpsMapPoint[], datasets: ImportedDataset[]): GpsEventMarker[] {
  const deduped = dedupeFlightEventMarkers(
    datasets
      .filter((dataset) => isEventSourceImporter(getImporterId(dataset)))
      .flatMap((dataset) => relativeEventMarkers(dataset))
  );

  return deduped
    .map((event, index) => {
      const point = interpolateGpsPoint(points, event.time);
      if (!point) {
        return null;
      }

      return {
        ...point,
        label: event.label,
        sourceLabel: event.sourceLabel,
        color: eventColorForLabel(event.canonicalLabel),
        labelOffsetY: 12 + (index % 3) * 10
      };
    })
    .filter((marker): marker is GpsEventMarker => marker !== null);
}

function findStandardColumns(
  config: ImportConfig | null,
  importerId: string
): StandardColumnMapping | null {
  if (!config || !importerId) return null;
  return (
    config.altimeters.find((altimeter) => altimeter.importerId === importerId)?.standardColumns ?? null
  );
}

export function FlightViewer({
  config,
  flight,
  isActive,
  selectedAltimeterDirectory,
  onDatasetUpdated
}: FlightViewerProps) {
  const [selectedDirectory, setSelectedDirectory] = useState('');
  const [dataset, setDataset] = useState<ImportedDataset | null>(null);
  const [loadError, setLoadError] = useState('');
  const [activeSection, setActiveSection] = useState<ViewerSection>('attributes');
  const [attributes, setAttributes] = useState<CustomAttribute[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<number[]>([]);
  const [hoverText, setHoverText] = useState('Hover over the chart to inspect values.');
  const [showFullData, setShowFullData] = useState(false);
  const [rawPage, setRawPage] = useState(0);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [eventDatasets, setEventDatasets] = useState<ImportedDataset[]>([]);
  const plot2dRef = useRef<HTMLDivElement | null>(null);
  const plot3dRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!flight) {
      setSelectedDirectory('');
      return;
    }

    setSelectedDirectory((current) => {
      const requested = selectedAltimeterDirectory;
      if (requested && flight.altimeters.some((altimeter) => altimeter.altimeterDirectory === requested)) {
        return requested;
      }

      if (current && flight.altimeters.some((altimeter) => altimeter.altimeterDirectory === current)) {
        return current;
      }

      return flight.altimeters[0]?.altimeterDirectory ?? '';
    });
  }, [flight, selectedAltimeterDirectory]);

  useEffect(() => {
    if (!selectedDirectory) {
      setDataset(null);
      return;
    }

    let ignore = false;
    setLoadError('');
    const started = performance.now();
    void window.appBridge.debugLog('viewer:read-dataset:start', {
      selectedDirectory
    });

    window.appBridge
      .readDataset(selectedDirectory)
      .then((nextDataset) => {
        if (ignore) return;
        setDataset(nextDataset);
        setAttributes(ensureRequiredAttributes(nextDataset.attributes, ENSURED_ATTRIBUTE_KEYS));
        const importerId =
          nextDataset.attributes.find((attr) => attr.key === 'importer_id')?.value ?? '';
        setSelectedSeries(
          defaultSeries(
            nextDataset.headers,
            getTimeColumn(nextDataset.headers, nextDataset.rows)?.index ?? null,
            findStandardColumns(config, importerId)
          )
        );
        setShowFullData(false);
        setRawPage(0);
        void window.appBridge.debugLog('viewer:read-dataset:ok', {
          selectedDirectory,
          durationMs: Math.round(performance.now() - started),
          rowCount: nextDataset.rows.length,
          headerCount: nextDataset.headers.length
        });
      })
      .catch((error: Error) => {
        if (!ignore) {
          setLoadError(error.message);
          void window.appBridge.debugLog('viewer:read-dataset:error', {
            selectedDirectory,
            durationMs: Math.round(performance.now() - started),
            message: error.message
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [selectedDirectory]);

  const hasAttributeChanges = useMemo(() => {
    if (!dataset) return false;
    const ensured = ensureRequiredAttributes(dataset.attributes, ENSURED_ATTRIBUTE_KEYS);
    return JSON.stringify(attributes) !== JSON.stringify(ensured);
  }, [attributes, dataset]);

  const hasRequiredFilled = hasRequiredAttributes(attributes, REQUIRED_ATTRIBUTE_KEYS);

  const rawXAxis = useMemo(
    () => (dataset ? buildXAxis(dataset) : { values: [], title: 'Row', hoverLabel: 'row' }),
    [dataset]
  );

  const rawEventData = useMemo(() => {
    if (!dataset) {
      return {
        events: [] as EventMarker[],
        launchTime: null as number | null,
        flightStartTime: 0,
        flightEndTime: 0
      };
    }
    return buildEventMarkers(dataset, rawXAxis.values);
  }, [dataset, rawXAxis.values]);
  const gpsColumns = useMemo(() => {
    if (!dataset) {
      return null;
    }

    const gpsPositionColumns = findGpsColumns(dataset.headers, dataset.rows);
    const altitudeIndex = getColumnIndexByAliases(dataset.headers, [
      'altitude',
      'altitude_m',
      'altitudem',
      'gps_alt'
    ]);

    if (!gpsPositionColumns || altitudeIndex === null) {
      return null;
    }

    return { ...gpsPositionColumns, altitudeIndex };
  }, [dataset]);
  const launchOffset = useMemo(() => {
    if (rawEventData.launchTime !== null) {
      return rawEventData.launchTime;
    }
    if (!dataset || !gpsColumns) {
      return 0;
    }

    const velocityIndex = getColumnIndexByAliases(dataset.headers, [
      'velocity_m_s',
      'velocity',
      'vertical_velocity',
      'speed_m_s'
    ]);
    return estimateGpsLaunchTime(dataset.rows, rawXAxis.values, gpsColumns.altitudeIndex, velocityIndex) ?? 0;
  }, [dataset, gpsColumns, rawEventData.launchTime, rawXAxis.values]);

  const xAxis = useMemo(
    () =>
      launchOffset === 0
        ? rawXAxis
        : { ...rawXAxis, values: rawXAxis.values.map((value) => value - launchOffset) },
    [rawXAxis, launchOffset]
  );
  const xValues = xAxis.values;

  const eventData = useMemo(
    () => {
      if (launchOffset === 0) {
        return rawEventData;
      }

      const relativeEndTime = (rawXAxis.values[rawXAxis.values.length - 1] ?? launchOffset) - launchOffset;
      const hasEventLaunch = rawEventData.launchTime !== null;

      return {
        ...rawEventData,
        events: rawEventData.events.map((event) => ({ ...event, time: event.time - launchOffset })),
        flightStartTime: hasEventLaunch ? rawEventData.flightStartTime - launchOffset : 0,
        flightEndTime: hasEventLaunch ? rawEventData.flightEndTime - launchOffset : relativeEndTime
      };
    },
    [rawEventData, launchOffset, rawXAxis.values]
  );

  const dataWindow = useMemo(
    () => buildWindow(xValues, eventData.flightStartTime, eventData.flightEndTime),
    [eventData.flightEndTime, eventData.flightStartTime, xValues]
  );

  const visibleIndexes = useMemo(() => {
    if (showFullData) {
      return dataset?.rows.map((_, index) => index) ?? [];
    }

    return xValues
      .map((time, index) => ({ time, index }))
      .filter(({ time }) => time >= dataWindow.start && time <= dataWindow.end)
      .map(({ index }) => index);
  }, [dataWindow.end, dataWindow.start, dataset, showFullData, xValues]);

  const visibleRows = useMemo(
    () => visibleIndexes.map((index) => dataset?.rows[index] ?? []),
    [dataset, visibleIndexes]
  );
  const visibleXValues = useMemo(() => visibleIndexes.map((index) => xValues[index]), [visibleIndexes, xValues]);
  const visibleEvents = useMemo(
    () =>
      eventData.events.filter((event) =>
        showFullData ? true : event.time >= dataWindow.start && event.time <= dataWindow.end
      ),
    [dataWindow.end, dataWindow.start, eventData.events, showFullData]
  );

  const eventLabelLevels = useMemo(() => {
    const lastVisible = visibleXValues[visibleXValues.length - 1];
    const firstVisible = visibleXValues[0];
    const visibleRange =
      typeof lastVisible === 'number' && typeof firstVisible === 'number' ? lastVisible - firstVisible : 0;
    // Threshold roughly approximates a rotated label's horizontal footprint (~font height)
    // expressed in time units: assume ~12px of label width on a ~800px plot.
    const threshold = visibleRange > 0 ? Math.max(visibleRange * 0.018, 1e-6) : 0;

    const indexed = visibleEvents.map((event, index) => ({ event, index }));
    indexed.sort((left, right) => left.event.time - right.event.time);

    const levels = new Array<number>(visibleEvents.length).fill(0);
    const active: { time: number; level: number }[] = [];

    for (const { event, index } of indexed) {
      while (active.length > 0 && event.time - active[0].time > threshold) {
        active.shift();
      }
      const used = new Set(active.map((entry) => entry.level));
      let level = 0;
      while (used.has(level)) level += 1;
      levels[index] = level;
      active.push({ time: event.time, level });
    }

    return levels;
  }, [visibleEvents, visibleXValues]);
  const gpsPoints = useMemo(() => {
    if (!gpsColumns) {
      return [];
    }

    const launchAltitude =
      visibleRows
        .map((row) => parseNumber(row[gpsColumns.altitudeIndex]))
        .find((value) => value !== null) ?? 0;

    return visibleRows
      .map((row, index) => ({
        latitude: parseNumber(row[gpsColumns.latitudeIndex]),
        longitude: parseNumber(row[gpsColumns.longitudeIndex]),
        altitude: parseNumber(row[gpsColumns.altitudeIndex]),
        time: visibleXValues[index]
      }))
      .filter(
        (point): point is { latitude: number; longitude: number; altitude: number; time: number } =>
          point.latitude !== null &&
          point.longitude !== null &&
          point.altitude !== null &&
          isValidLatitude(point.latitude) &&
          isValidLongitude(point.longitude) &&
          Number.isFinite(point.time)
      )
      .map((point) => ({
        ...point,
        height: Math.max(0, point.altitude - launchAltitude)
      }));
  }, [gpsColumns, visibleRows, visibleXValues]);
  const gpsAspectRatio = useMemo(() => {
    if (gpsPoints.length === 0) {
      return { x: 1, y: 1, z: 1 };
    }

    const lonRange = axisRange(gpsPoints.map((point) => point.longitude));
    const latRange = axisRange(gpsPoints.map((point) => point.latitude));
    const horizontalRange = Math.max(lonRange, latRange, 1e-9);
    const xRatio = Math.max(lonRange / horizontalRange, 1e-6);
    const yRatio = Math.max(latRange / horizontalRange, 1e-6);

    return {
      x: xRatio,
      y: yRatio,
      z: 1
    };
  }, [gpsPoints]);
  const selectedImporterId = dataset ? getImporterId(dataset) : '';
  const fcbRocketSamples = useMemo((): RocketPosePoint[] => {
    if (!dataset || selectedImporterId !== 'fcb' || !gpsColumns) {
      return [];
    }

    const qxIndex = getColumnIndexByAliases(dataset.headers, ['q_x', 'quaternion_x']);
    const qyIndex = getColumnIndexByAliases(dataset.headers, ['q_y', 'quaternion_y']);
    const qzIndex = getColumnIndexByAliases(dataset.headers, ['q_z', 'quaternion_z']);
    const qwIndex = getColumnIndexByAliases(dataset.headers, ['q_w', 'quaternion_w']);

    if (qxIndex === null || qyIndex === null || qzIndex === null || qwIndex === null) {
      return [];
    }

    const quaternionColumns = { qxIndex, qyIndex, qzIndex, qwIndex };
    const northCorrectionDeg = computeNorthAlignmentDegrees(dataset, xValues, gpsColumns, quaternionColumns);

    const launchAltitude =
      visibleRows
        .map((row) => parseNumber(row[gpsColumns.altitudeIndex]))
        .find((value) => value !== null) ?? 0;

    return visibleRows
      .map((row, index) => {
        const latitude = parseNumber(row[gpsColumns.latitudeIndex]);
        const longitude = parseNumber(row[gpsColumns.longitudeIndex]);
        const altitude = parseNumber(row[gpsColumns.altitudeIndex]);
        const qx = parseNumber(row[qxIndex]);
        const qy = parseNumber(row[qyIndex]);
        const qz = parseNumber(row[qzIndex]);
        const qw = parseNumber(row[qwIndex]);
        const time = visibleXValues[index];

        if (
          latitude === null ||
          longitude === null ||
          altitude === null ||
          !isValidLatitude(latitude) ||
          !isValidLongitude(longitude) ||
          qx === null ||
          qy === null ||
          qz === null ||
          qw === null ||
          !Number.isFinite(time)
        ) {
          return null;
        }

        const quaternion = normalizeQuaternion(qx, qy, qz, qw);
        if (!quaternion) {
          return null;
        }

        return {
          latitude,
          longitude,
          altitude,
          height: Math.max(0, altitude - launchAltitude),
          time,
          northCorrectionDeg,
          ...quaternion
        };
      })
      .filter((sample): sample is RocketPosePoint => sample !== null);
  }, [dataset, gpsColumns, selectedImporterId, visibleRows, visibleXValues, xValues]);
  const gpsViewActive =
    activeSection === 'plot3d' ||
    activeSection === 'map2d' ||
    activeSection === 'map3d' ||
    activeSection === 'rocketReplay';

  useEffect(() => {
    if (!flight || !dataset || !gpsColumns || !gpsViewActive) {
      setEventDatasets([]);
      return;
    }

    let ignore = false;
    const relevantAltimeters = flight.altimeters.filter((altimeter) =>
      isEventSourceImporter(altimeter.attributes.importer_id ?? '')
    );

    Promise.all(
      relevantAltimeters.map((altimeter) => {
        if (altimeter.altimeterDirectory === selectedDirectory) {
          return Promise.resolve(dataset);
        }

        return window.appBridge.readDataset(altimeter.altimeterDirectory).catch(() => null);
      })
    ).then((datasets) => {
      if (ignore) return;
      setEventDatasets(datasets.filter((entry): entry is ImportedDataset => entry !== null));
    });

    return () => {
      ignore = true;
    };
  }, [dataset, flight, gpsColumns, gpsViewActive, selectedDirectory]);

  const gpsEventMarkers = useMemo(
    () => buildGpsEventMarkers(gpsPoints, eventDatasets),
    [eventDatasets, gpsPoints]
  );

  useEffect(() => {
    setRawPage(0);
  }, [dataset, showFullData]);

  useEffect(() => {
    const plotElement = plot2dRef.current;
    if (!isActive || !plotElement || !dataset || activeSection !== 'plot2d') {
      return;
    }
    const started = performance.now();
    void window.appBridge.debugLog('viewer:plot2d:start', {
      selectedDirectory,
      selectedSeriesCount: selectedSeries.length,
      visiblePointCount: visibleRows.length,
      visibleEventCount: visibleEvents.length
    });

    const traces = selectedSeries.map((seriesIndex) => ({
      x: visibleXValues,
      y: visibleRows.map((row) => parseNumber(row[seriesIndex]) ?? Number.NaN),
      name: dataset.headers[seriesIndex],
      mode: 'lines',
      type: 'scatter',
      hoverinfo: 'none'
    }));

    Plotly2D.newPlot(
      plotElement,
      traces,
      {
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#e4e7eb' },
        margin: { t: 24, r: 24, b: 48, l: 64 },
        hovermode: 'x',
        shapes: visibleEvents.map((event) => ({
          type: 'line',
          x0: event.time,
          x1: event.time,
          y0: 0,
          y1: 1,
          yref: 'paper',
          line: { color: event.color, width: 1, dash: 'dash' }
        })),
        annotations: visibleEvents.map((event, index) => ({
          x: event.time,
          y: 1,
          yref: 'paper',
          yanchor: 'top',
          yshift: -(eventLabelLevels[index] ?? 0) * 90,
          text: event.label,
          showarrow: false,
          textangle: -90,
          xanchor: 'right',
          font: { color: event.color, size: 10 }
        })),
        xaxis: {
          title: xAxis.title,
          gridcolor: '#30343a',
          showspikes: true,
          spikemode: 'across',
          spikesnap: 'cursor',
          spikedash: 'dash',
          spikecolor: '#aab2bd',
          spikethickness: 1
        },
        yaxis: {
          title: 'Value',
          gridcolor: '#30343a'
        },
        legend: {
          orientation: 'h',
          yanchor: 'bottom',
          y: 1.02,
          xanchor: 'right',
          x: 1
        }
      },
      {
        responsive: true,
        displaylogo: false,
        scrollZoom: true
      }
    ).then(() => {
      void window.appBridge.debugLog('viewer:plot2d:ok', {
        selectedDirectory,
        durationMs: Math.round(performance.now() - started),
        selectedSeriesCount: selectedSeries.length,
        visiblePointCount: visibleRows.length,
        visibleEventCount: visibleEvents.length
      });
      const interactivePlot = plotElement as PlotElement;
      interactivePlot.removeAllListeners?.('plotly_hover');
      interactivePlot.removeAllListeners?.('plotly_unhover');
      interactivePlot.on?.('plotly_hover', (event) => {
        if (!event.points?.length) return;

        const hoveredX = event.points[0]?.x;
        const hoverValue = typeof hoveredX === 'number' ? hoveredX.toFixed(3) : hoveredX;
        const values = event.points
          .map((point) => `${point.data.name ?? 'series'}: ${point.y.toFixed(3)}`)
          .join('   ');
        setHoverText(`${xAxis.hoverLabel}: ${hoverValue}${xAxis.hoverLabel === 'time' ? ' s' : ''}   ${values}`);
      });
      interactivePlot.on?.('plotly_unhover', () => {
        setHoverText('Hover over the chart to inspect values.');
      });
      Plotly2D.Plots.resize(plotElement);
    });

    return () => {
      Plotly2D.purge(plotElement);
    };
  }, [
    activeSection,
    dataset,
    eventLabelLevels,
    isActive,
    selectedSeries,
    visibleEvents,
    visibleRows,
    visibleXValues,
    xAxis.hoverLabel,
    xAxis.title
  ]);

  useEffect(() => {
    const plotElement = plot3dRef.current;
    if (!isActive || !plotElement || !dataset || activeSection !== 'plot3d' || !gpsColumns) {
      return;
    }

    Plotly3D.newPlot(
      plotElement,
      [
        {
          type: 'scatter3d',
          mode: 'lines+markers',
          x: gpsPoints.map((point) => point.longitude),
          y: gpsPoints.map((point) => point.latitude),
          z: gpsPoints.map((point) => point.altitude),
          text: gpsPoints.map((point) => `t=${point.time.toFixed(2)}s`),
          hovertemplate:
            'Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Alt: %{z:.2f} m<br>%{text}<extra></extra>',
          line: {
            width: 4,
            color: gpsPoints.map((point) => point.time),
            colorscale: 'Turbo'
          },
          marker: {
            size: 3,
            color: gpsPoints.map((point) => point.time),
            colorscale: 'Turbo',
            showscale: true,
            colorbar: { title: 'Time (s)' }
          }
        },
        {
          type: 'scatter3d',
          mode: 'markers+text',
          x: gpsEventMarkers.map((point) => point.longitude),
          y: gpsEventMarkers.map((point) => point.latitude),
          z: gpsEventMarkers.map((point) => point.altitude),
          text: gpsEventMarkers.map((point) => point.label),
          textposition: 'top center',
          hovertemplate:
            '%{text}<br>Source: %{customdata}<br>Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Alt: %{z:.2f} m<br>Time: %{meta:.2f} s<extra></extra>',
          customdata: gpsEventMarkers.map((point) => point.sourceLabel),
          meta: gpsEventMarkers.map((point) => point.time),
          marker: {
            size: 5,
            color: gpsEventMarkers.map(
              (point) => `rgba(${point.color[0]}, ${point.color[1]}, ${point.color[2]}, ${point.color[3] / 255})`
            ),
            line: {
              color: '#ffffff',
              width: 1
            }
          }
        }
      ],
      {
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#e4e7eb' },
        margin: { t: 24, r: 24, b: 24, l: 24 },
        scene: {
          aspectmode: 'manual',
          aspectratio: gpsAspectRatio,
          xaxis: { title: 'Longitude', gridcolor: '#30343a' },
          yaxis: { title: 'Latitude', gridcolor: '#30343a' },
          zaxis: { title: 'Altitude (m)', gridcolor: '#30343a' },
          bgcolor: 'rgba(0,0,0,0)'
        }
      },
      {
        responsive: true,
        displaylogo: false,
        scrollZoom: true
      }
    ).then(() => {
      Plotly3D.Plots.resize(plotElement);
    });

    return () => {
      Plotly3D.purge(plotElement);
    };
  }, [activeSection, dataset, gpsAspectRatio, gpsColumns, gpsEventMarkers, gpsPoints, isActive]);

  const saveAttributes = async () => {
    if (!dataset || !hasAttributeChanges) return;

    setIsSaving(true);
    setSaveStatus('');
    setSaveError('');

    try {
      const nextDataset = await window.appBridge.saveDatasetAttributes({
        datasetDirectory: selectedDirectory,
        attributes
      });
      setDataset(nextDataset);
      setAttributes(nextDataset.attributes);
      setSaveStatus('Attributes saved.');
      await onDatasetUpdated();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save attributes.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!flight) {
    return <div className="muted-text">Flight is not available in the current directory.</div>;
  }

  if (loadError) {
    return <div className="error-text">{loadError}</div>;
  }

  const numericSeries =
    dataset?.headers.map((header, index) => ({ header, index })).filter((series) => series.index > 0) ?? [];
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const boundedPage = Math.min(rawPage, totalPages - 1);
  const pagedRows = visibleRows.slice(boundedPage * PAGE_SIZE, (boundedPage + 1) * PAGE_SIZE);

  return (
    <div className="viewer">
      <header className="viewer-header">
        <div>
          <h2>{flight.directoryName}</h2>
        </div>
        <button
          className="small-button"
          onClick={() => setShowFullData((current) => !current)}
          type="button"
        >
          {showFullData ? 'Flight Window' : 'Full Data'}
        </button>
      </header>

      <nav className="altimeter-tabbar" aria-label="Altimeters">
        {flight.altimeters.map((altimeter) => (
          <button
            className={selectedDirectory === altimeter.altimeterDirectory ? 'active' : ''}
            key={altimeter.id}
            onClick={() => setSelectedDirectory(altimeter.altimeterDirectory)}
            type="button"
          >
            {altimeter.altimeterDirectoryName}
          </button>
        ))}
      </nav>

      <div className="viewer-body">
        <nav className="view-sidebar" aria-label="Dataset views">
          <button
            className={activeSection === 'attributes' ? 'active' : ''}
            onClick={() => setActiveSection('attributes')}
            type="button"
          >
            Attributes
          </button>
          <button
            className={activeSection === 'plot2d' ? 'active' : ''}
            onClick={() => setActiveSection('plot2d')}
            type="button"
          >
            2D Plot
          </button>
          <button
            className={activeSection === 'plot3d' ? 'active' : ''}
            onClick={() => setActiveSection('plot3d')}
            type="button"
          >
            3D Graph
          </button>
          <button
            className={activeSection === 'map2d' ? 'active' : ''}
            onClick={() => setActiveSection('map2d')}
            type="button"
          >
            Flight Map
          </button>
          <button
            className={activeSection === 'map3d' ? 'active' : ''}
            onClick={() => setActiveSection('map3d')}
            type="button"
          >
            Flight Map 3D
          </button>
          <button
            className={activeSection === 'rocketReplay' ? 'active' : ''}
            onClick={() => setActiveSection('rocketReplay')}
            type="button"
          >
            Rocket Replay
          </button>
          <button
            className={activeSection === 'raw' ? 'active' : ''}
            onClick={() => setActiveSection('raw')}
            type="button"
          >
            Raw Data
          </button>
        </nav>

        <div className="viewer-content">
          {!dataset ? <div className="muted-text">Loading dataset...</div> : null}

          {dataset && activeSection === 'attributes' ? (
            <section className="viewer-panel">
              <div className="panel-header">
                <h2>Attributes</h2>
                <span>{dataset.summary.altimeterDirectoryName}</span>
              </div>
              <AttributeEditor
                attributes={attributes}
                emptyText="No attributes."
                onChange={(next) => setAttributes(ensureRequiredAttributes(next, ENSURED_ATTRIBUTE_KEYS))}
                requiredKeys={REQUIRED_ATTRIBUTE_KEYS}
                multilineKeys={MULTILINE_ATTRIBUTE_KEYS}
              />
              <footer className="import-actions">
                {saveStatus ? <div className="success-text">{saveStatus}</div> : null}
                {saveError ? <div className="error-text">{saveError}</div> : null}
                {!hasRequiredFilled ? (
                  <div className="warning-text">Motor is required.</div>
                ) : null}
                <button
                  className="primary-button"
                  disabled={!hasAttributeChanges || !hasRequiredFilled || isSaving}
                  onClick={saveAttributes}
                  type="button"
                >
                  {isSaving ? 'Saving' : 'Save Attributes'}
                </button>
              </footer>
            </section>
          ) : null}

          {dataset && activeSection === 'plot2d' ? (
            <section className="plot-layout">
              <aside className="series-panel">
                <div className="section-title">Series</div>
                <div className="series-list">
                  {numericSeries.map((series) => (
                    <label className="checkbox-row" key={series.index}>
                      <input
                        checked={selectedSeries.includes(series.index)}
                        onChange={(event) => {
                          setSelectedSeries((current) =>
                            event.target.checked
                              ? [...current, series.index]
                              : current.filter((index) => index !== series.index)
                          );
                        }}
                        type="checkbox"
                      />
                      {series.header}
                    </label>
                  ))}
                </div>
              </aside>
              <div className="plot-main">
                <div className="hover-dashboard">{hoverText}</div>
                <div className="plot-surface" ref={plot2dRef} />
              </div>
            </section>
          ) : null}

          {dataset && activeSection === 'plot3d' ? (
            <section className="plot3d-layout">
              {gpsColumns ? (
                <div className="plot-surface" ref={plot3dRef} />
              ) : (
                <div className="viewer-panel">
                  <h2>3D Plot</h2>
                  <p>No GPS 3D dataset is available for this altimeter.</p>
                </div>
              )}
            </section>
          ) : null}

          {dataset && activeSection === 'map2d' ? (
            <section className="plot3d-layout">
              {gpsColumns ? (
                <GpsMapView
                  eventMarkers={gpsEventMarkers}
                  isActive={isActive}
                  mode="map2d"
                  points={gpsPoints}
                />
              ) : (
                <div className="viewer-panel">
                  <h2>Flight Map</h2>
                  <p>No GPS dataset is available for this altimeter.</p>
                </div>
              )}
            </section>
          ) : null}

          {dataset && activeSection === 'map3d' ? (
            <section className="plot3d-layout">
              {gpsColumns ? (
                <GpsMapView
                  eventMarkers={gpsEventMarkers}
                  isActive={isActive}
                  mode="map3d"
                  points={gpsPoints}
                />
              ) : (
                <div className="viewer-panel">
                  <h2>Flight Map 3D</h2>
                  <p>No GPS dataset is available for this altimeter.</p>
                </div>
              )}
            </section>
          ) : null}

          {dataset && activeSection === 'rocketReplay' ? (
            <section className="plot3d-layout">
              {selectedImporterId === 'fcb' ? (
                <FcbRocketReplayMap
                  eventMarkers={gpsEventMarkers}
                  isActive={isActive}
                  samples={fcbRocketSamples}
                />
              ) : (
                <div className="viewer-panel">
                  <h2>Rocket Replay</h2>
                  <p>Rocket replay is currently only supported for FCB altimeters.</p>
                </div>
              )}
            </section>
          ) : null}

          {dataset && activeSection === 'raw' ? (
            <section className="raw-data-shell">
              <div className="raw-toolbar">
                <span>
                  Rows {visibleRows.length === 0 ? 0 : boundedPage * PAGE_SIZE + 1}-
                  {Math.min((boundedPage + 1) * PAGE_SIZE, visibleRows.length)} of {visibleRows.length}
                </span>
                <div className="pager">
                  <button
                    className="small-button"
                    disabled={boundedPage === 0}
                    onClick={() => setRawPage((page) => Math.max(0, page - 1))}
                    type="button"
                  >
                    Previous
                  </button>
                  <span>
                    {boundedPage + 1} / {totalPages}
                  </span>
                  <button
                    className="small-button"
                    disabled={boundedPage >= totalPages - 1}
                    onClick={() => setRawPage((page) => Math.min(totalPages - 1, page + 1))}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              </div>
              <div className="raw-data-panel">
                <table className="data-table">
                  <thead>
                    <tr>
                      {dataset.headers.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row, rowIndex) => (
                      <tr key={`${boundedPage}-${rowIndex}`}>
                        {dataset.headers.map((header, columnIndex) => (
                          <td key={`${rowIndex}-${header}`}>{row[columnIndex]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
