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
