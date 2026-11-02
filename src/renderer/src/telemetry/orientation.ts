/*
 * FCB rocket-replay orientation math.
 *
 * Altimeter-specific (FCB quaternion + magnetometer telemetry) but isolated
 * here so the FlightViewer component stays focused on view/layout. Turns
 * body-frame quaternions + magnetometer readings into a true-north correction
 * for the 3D rocket replay, using the geomagnetic model for declination.
 */
import { model as geomagneticModel } from 'geomagnetism';
import type { ImportedDataset } from '../importTypes';
import type { GpsColumns } from './gps';
import { getColumnIndexByAliases, isValidLatitude, isValidLongitude, parseNumber } from './core';

export type QuaternionColumns = {
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

export function normalizeQuaternion(x: number, y: number, z: number, w: number) {
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

export function computeNorthAlignmentDegrees(
  dataset: ImportedDataset,
  xValues: number[],
  gpsColumns: GpsColumns,
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

/*
 * SillyGoose-family (SeriousGoose) replay orientation.
 *
 * The firmware logs quaternion_a..d (a = scalar part) rotating the board frame into a world frame
 * with +Z up and an arbitrary heading. The replay mesh points along +X in an east/north/up world,
 * so the board's nose axis is taken from the pre-launch samples (the board axis that points up on
 * the pad) and the heading is aligned to the GPS ground track during ascent.
 */
type Quaternion = { qX: number; qY: number; qZ: number; qW: number };
type Vector3 = [number, number, number];

const BOARD_AXES: Vector3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];
const EARTH_METERS_PER_DEGREE = 111_320;
const TRACK_BASELINE_SECONDS = 1;
const TRACK_MIN_HORIZONTAL_METERS = 2;
const NOSE_MIN_HORIZONTAL = 0.05;

function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  return {
    qW: left.qW * right.qW - left.qX * right.qX - left.qY * right.qY - left.qZ * right.qZ,
    qX: left.qW * right.qX + left.qX * right.qW + left.qY * right.qZ - left.qZ * right.qY,
    qY: left.qW * right.qY - left.qX * right.qZ + left.qY * right.qW + left.qZ * right.qX,
    qZ: left.qW * right.qZ + left.qX * right.qY - left.qY * right.qX + left.qZ * right.qW
  };
}

function rotationFromPlusX(target: Vector3): Quaternion {
  const dot = target[0];
  if (dot > 0.999999) return { qX: 0, qY: 0, qZ: 0, qW: 1 };
  if (dot < -0.999999) return { qX: 0, qY: 0, qZ: 1, qW: 0 };
  const axis: Vector3 = [0, -target[2], target[1]];
  const halfAngle = Math.acos(dot) / 2;
  const axisLength = Math.hypot(axis[1], axis[2]);
  const scale = Math.sin(halfAngle) / axisLength;
  return { qX: 0, qY: axis[1] * scale, qZ: axis[2] * scale, qW: Math.cos(halfAngle) };
}

export function findGooseQuaternionColumns(headers: string[]): QuaternionColumns | null {
  const qwIndex = getColumnIndexByAliases(headers, ['quaternion_a']);
  const qxIndex = getColumnIndexByAliases(headers, ['quaternion_b']);
  const qyIndex = getColumnIndexByAliases(headers, ['quaternion_c']);
  const qzIndex = getColumnIndexByAliases(headers, ['quaternion_d']);
  if (qwIndex === null || qxIndex === null || qyIndex === null || qzIndex === null) return null;
  return { qxIndex, qyIndex, qzIndex, qwIndex };
}

function rowQuaternion(row: string[], columns: QuaternionColumns) {
  const qx = parseNumber(row[columns.qxIndex]);
  const qy = parseNumber(row[columns.qyIndex]);
  const qz = parseNumber(row[columns.qzIndex]);
  const qw = parseNumber(row[columns.qwIndex]);
  if (qx === null || qy === null || qz === null || qw === null) return null;
  return normalizeQuaternion(qx, qy, qz, qw);
}

export type GooseReplayPose = {
  quaternions: (Quaternion | null)[];
  northCorrectionDeg: number;
};

export function computeGooseReplayPose(
  dataset: ImportedDataset,
  xValues: number[],
  gpsColumns: GpsColumns,
  columns: QuaternionColumns
): GooseReplayPose | null {
  if (dataset.rows.length === 0 || xValues.length !== dataset.rows.length) return null;
  const boardQuaternions = dataset.rows.map((row) => rowQuaternion(row, columns));

  const padIndexes = calibrationIndexes(xValues);
  let noseAxis: Vector3 | null = null;
  let bestUp = Number.NEGATIVE_INFINITY;
  for (const axis of BOARD_AXES) {
    let upSum = 0;
    let count = 0;
    for (const index of padIndexes) {
      const quaternion = boardQuaternions[index];
      if (!quaternion) continue;
      upSum += rotateVectorByQuaternion(quaternion, axis)[2];
      count += 1;
    }
    if (count > 0 && upSum / count > bestUp) {
      bestUp = upSum / count;
      noseAxis = axis;
    }
  }
  if (!noseAxis) return null;

  const meshToBoard = rotationFromPlusX(noseAxis);
  const quaternions = boardQuaternions.map((quaternion) =>
    quaternion ? multiplyQuaternions(quaternion, meshToBoard) : null
  );

  let apogeeIndex = -1;
  let apogeeAltitude = Number.NEGATIVE_INFINITY;
  dataset.rows.forEach((row, index) => {
    const altitude = parseNumber(row[gpsColumns.altitudeIndex]);
    if (altitude !== null && xValues[index] >= 0 && altitude > apogeeAltitude) {
      apogeeAltitude = altitude;
      apogeeIndex = index;
    }
  });

  let sinSum = 0;
  let cosSum = 0;
  let baseIndex = -1;
  for (let index = 0; index <= apogeeIndex; index += 1) {
    const time = xValues[index];
    if (!Number.isFinite(time) || time < 0) continue;
    if (baseIndex < 0) {
      baseIndex = index;
      continue;
    }
    if (time - xValues[baseIndex] < TRACK_BASELINE_SECONDS) continue;

    const baseRow = dataset.rows[baseIndex];
    const row = dataset.rows[index];
    const baseIndexUsed = baseIndex;
    baseIndex = index;
    const latitude = parseNumber(row[gpsColumns.latitudeIndex]);
    const longitude = parseNumber(row[gpsColumns.longitudeIndex]);
    const baseLatitude = parseNumber(baseRow[gpsColumns.latitudeIndex]);
    const baseLongitude = parseNumber(baseRow[gpsColumns.longitudeIndex]);
    if (!isValidLatitude(latitude) || !isValidLongitude(longitude) || !isValidLatitude(baseLatitude) || !isValidLongitude(baseLongitude)) continue;

    const north = (latitude - baseLatitude) * EARTH_METERS_PER_DEGREE;
    const east = (longitude - baseLongitude) * EARTH_METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
    const trackMeters = Math.hypot(east, north);
    if (trackMeters < TRACK_MIN_HORIZONTAL_METERS) continue;

    const quaternion = quaternions[Math.round((baseIndexUsed + index) / 2)];
    if (!quaternion) continue;
    const nose = rotateVectorByQuaternion(quaternion, [1, 0, 0]);
    const noseHorizontal = Math.hypot(nose[0], nose[1]);
    if (noseHorizontal < NOSE_MIN_HORIZONTAL) continue;

    const offset = Math.atan2(north, east) - Math.atan2(nose[1], nose[0]);
    const weight = trackMeters * noseHorizontal;
    sinSum += Math.sin(offset) * weight;
    cosSum += Math.cos(offset) * weight;
  }

  const northCorrectionDeg = sinSum === 0 && cosSum === 0 ? 0 : (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
  return { quaternions, northCorrectionDeg };
}
