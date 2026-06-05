import type { ColumnUnitMap, UnitFamily } from '../../shared/units';

const TIME_MS = { family: 'time', unit: 'ms' } as const;
const TIME_S = { family: 'time', unit: 's' } as const;
const LENGTH_M = { family: 'length', unit: 'm' } as const;
const LENGTH_FT = { family: 'length', unit: 'ft' } as const;
const VELOCITY_MS = { family: 'velocity', unit: 'm/s' } as const;
const VELOCITY_FTS = { family: 'velocity', unit: 'ft/s' } as const;
const ACCELERATION_MSS = { family: 'acceleration', unit: 'm/s^2' } as const;
const TEMP_C = { family: 'temperature', unit: 'C' } as const;
const TEMP_F = { family: 'temperature', unit: 'F' } as const;
const TEMP_K = { family: 'temperature', unit: 'K' } as const;
const PRESSURE_PA = { family: 'pressure', unit: 'Pa' } as const;
const VOLTAGE_V = { family: 'voltage', unit: 'V' } as const;
const ANGLE_DEG = { family: 'angle', unit: 'deg' } as const;
const ANGLE_RAD = { family: 'angle', unit: 'rad' } as const;
const ANGULAR_VELOCITY_RADS = { family: 'angularVelocity', unit: 'rad/s' } as const;
const DIMENSIONLESS = { family: 'dimensionless', unit: '' } as const;

function unit(family: UnitFamily, unitName: string) {
  return { family, unit: unitName };
}

export const SILLYGOOSE_COLUMN_UNITS: ColumnUnitMap = {
  timestampMs: TIME_MS,
  pressurePa: PRESSURE_PA,
  tempK: TEMP_K,
  accelX: ACCELERATION_MSS,
  accelY: ACCELERATION_MSS,
  accelZ: ACCELERATION_MSS,
  gyroX: ANGULAR_VELOCITY_RADS,
  gyroY: ANGULAR_VELOCITY_RADS,
  gyroZ: ANGULAR_VELOCITY_RADS,
  imuTemp: TEMP_K,
  battV: VOLTAGE_V,
  altitudeM: LENGTH_M,
  velocityMS: VELOCITY_MS,
  accelerationMSS: ACCELERATION_MSS,
  unfiltAlt: LENGTH_M,
  tiltMagnitudeDeg: ANGLE_DEG,
  angularVelRadS_x: ANGULAR_VELOCITY_RADS,
  angularVelRadS_y: ANGULAR_VELOCITY_RADS,
  angularVelRadS_z: ANGULAR_VELOCITY_RADS,
  quaternion_a: DIMENSIONLESS,
  quaternion_b: DIMENSIONLESS,
  quaternion_c: DIMENSIONLESS,
  quaternion_d: DIMENSIONLESS
};

export const EASYMINI_COLUMN_UNITS: ColumnUnitMap = {
  time: TIME_S,
  acceleration: ACCELERATION_MSS,
  pressure: PRESSURE_PA,
  altitude: LENGTH_M,
  height: LENGTH_M,
  speed: VELOCITY_MS,
  temperature: TEMP_C,
  drogue_voltage: VOLTAGE_V,
  main_voltage: VOLTAGE_V,
  battery_voltage: VOLTAGE_V
};

export const STRATOLOGGER_COLUMN_UNITS: ColumnUnitMap = {
  timeS: TIME_S,
  altitudeFt: LENGTH_FT,
  velocityFtS: VELOCITY_FTS,
  temperatureF: TEMP_F,
  batteryVoltageV: VOLTAGE_V
};

export const RAW_GPS_COLUMN_UNITS: ColumnUnitMap = {
  timestamp: TIME_S,
  latitude: ANGLE_DEG,
  longitude: ANGLE_DEG,
  altitude: LENGTH_M
};

export const FCB_GROUND_STATION_COLUMN_UNITS: ColumnUnitMap = {
  timestamp_ms: TIME_MS,
  rssi_db: unit('other', 'dB'),
  temperature_c: TEMP_C,
  altitude_m: LENGTH_M,
  velocity_m_s: VELOCITY_MS,
  latitude: ANGLE_DEG,
  longitude: ANGLE_DEG,
  gps_altitude_m: LENGTH_M,
  battery_v: VOLTAGE_V,
  ground_speed_m_s: VELOCITY_MS,
  course_deg: ANGLE_DEG,
  accel_x_m_s2: ACCELERATION_MSS,
  accel_y_m_s2: ACCELERATION_MSS,
  accel_z_m_s2: ACCELERATION_MSS,
  accel_total_m_s2: ACCELERATION_MSS,
  gyro_x_rad_s: ANGULAR_VELOCITY_RADS,
  gyro_y_rad_s: ANGULAR_VELOCITY_RADS,
  gyro_z_rad_s: ANGULAR_VELOCITY_RADS,
  angle_vertical_deg: ANGLE_DEG,
  roll_rad: ANGLE_RAD,
  pitch_rad: ANGLE_RAD,
  yaw_rad: ANGLE_RAD,
  q_x: DIMENSIONLESS,
  q_y: DIMENSIONLESS,
  q_z: DIMENSIONLESS,
  q_w: DIMENSIONLESS,
  ground_elev_m: LENGTH_M,
  ground_temp_c: TEMP_C
};

function timestampColumnLooksLikeSeconds(rows: string[][], columnIndex: number) {
  let min: number | null = null;
  let max: number | null = null;
  let previous: number | null = null;
  let numericCount = 0;
  let fractionalCount = 0;
  const deltas: number[] = [];

  for (const row of rows) {
    const raw = row[columnIndex];
    const value = Number.parseFloat(raw ?? '');
    if (!Number.isFinite(value)) continue;
    numericCount += 1;
    if (raw?.includes('.') && Math.abs(value - Math.trunc(value)) > 1e-9) {
      fractionalCount += 1;
    }
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
    if (previous !== null) {
      const delta = Math.abs(value - previous);
      if (delta > 0) deltas.push(delta);
    }
    previous = value;
  }

  if (min === null || max === null || deltas.length === 0) return false;

  const sortedDeltas = deltas.sort((left, right) => left - right);
  const medianDelta = sortedDeltas[Math.floor(sortedDeltas.length / 2)] ?? null;
  if (medianDelta === null) return false;

  const rawRange = Math.abs(max - min);
  const rangeIfMilliseconds = rawRange * 0.001;
  const rangeIfSeconds = rawRange;
  const fractionalRatio = numericCount > 0 ? fractionalCount / numericCount : 0;

  return (
    rangeIfMilliseconds < 5 &&
    rangeIfSeconds >= 5 &&
    (fractionalRatio > 0.05 || medianDelta < 5)
  );
}

export function inferFcbColumnUnits(headers: string[], rows: string[][] = []): ColumnUnitMap {
  const units: ColumnUnitMap = {};

  for (const [index, header] of headers.entries()) {
    if (header.includes('timestamp_ms')) {
      units[header] = timestampColumnLooksLikeSeconds(rows, index) ? TIME_S : TIME_MS;
    }
    else if (header.includes('timestamp')) units[header] = TIME_S;
    else if (/^(pos_[xyz]|.*altitude.*|height.*)$/.test(header)) units[header] = LENGTH_M;
    else if (/^(vel_[xyz]|.*velocity.*|.*speed.*)$/.test(header)) units[header] = VELOCITY_MS;
    else if (/^(acc_[xyz]|.*accel.*|.*acceleration.*)$/.test(header)) units[header] = ACCELERATION_MSS;
    else if (header.includes('lat') || header.includes('lon')) units[header] = ANGLE_DEG;
    else if (header.includes('gyro')) units[header] = ANGULAR_VELOCITY_RADS;
    else if (header.includes('temp')) units[header] = TEMP_C;
    else if (header.includes('battery') || header.endsWith('_v')) units[header] = VOLTAGE_V;
    else if (header.startsWith('q_') || header.includes('quaternion')) units[header] = DIMENSIONLESS;
  }

  return units;
}
