import {
  applySanitizationAttributes,
  countValidGpsRows,
  sanitizeRows,
  type SanitizationConfig,
  type SanitizationSummary
} from './sanitization';

const FCB_ALLOWED_STATES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

const FCB_GROUND_STATION_NUMERIC_RANGES = [
  { column: 'rssi_db', min: -150, max: 20 },
  { column: 'lqi', min: 0, max: 255 },
  { column: 'software_version', min: 0, max: 10_000 },
  { column: 'board_serial_number', min: 0, max: 1_000_000_000 },
  { column: 'temperature_c', min: -80, max: 120 },
  { column: 'altitude_m', min: -2_000, max: 150_000 },
  { column: 'velocity_m_s', min: -2_000, max: 2_000 },
  { column: 'gps_altitude_m', min: -2_000, max: 150_000 },
  { column: 'battery_v', min: 0, max: 80 },
  { column: 'ground_speed_m_s', min: 0, max: 2_000 },
  { column: 'course_deg', min: 0, max: 360 },
  { column: 'gps_sats', min: 0, max: 128 },
  { column: 'ble_client', min: 0, max: 255 },
  { column: 'accel_x_m_s2', min: -500, max: 500 },
  { column: 'accel_y_m_s2', min: -500, max: 500 },
  { column: 'accel_z_m_s2', min: -500, max: 500 },
  { column: 'accel_total_m_s2', min: 0, max: 500 },
  { column: 'gyro_x_rad_s', min: -100, max: 100 },
  { column: 'gyro_y_rad_s', min: -100, max: 100 },
  { column: 'gyro_z_rad_s', min: -100, max: 100 },
  { column: 'magnetic_x', min: -1_000, max: 1_000 },
  { column: 'magnetic_y', min: -1_000, max: 1_000 },
  { column: 'magnetic_z', min: -1_000, max: 1_000 },
  { column: 'angle_vertical_deg', min: 0, max: 180 },
  { column: 'roll_rad', min: -Math.PI, max: Math.PI },
  { column: 'pitch_rad', min: -Math.PI, max: Math.PI },
  { column: 'yaw_rad', min: -Math.PI, max: Math.PI },
  { column: 'q_x', min: -1.5, max: 1.5 },
  { column: 'q_y', min: -1.5, max: 1.5 },
  { column: 'q_z', min: -1.5, max: 1.5 },
  { column: 'q_w', min: -1.5, max: 1.5 },
  { column: 'barometer_pressure', min: 0.1, max: 1.5 },
  { column: 'barometer_2_pressure', min: 0.1, max: 1.5 },
  { column: 'pressure_ref', min: 0.1, max: 1.5 },
  { column: 'ground_elev_m', min: -1_000, max: 10_000 },
  { column: 'ground_temp_c', min: -80, max: 120 },
  { column: 'pitot_ducer_press', min: -100, max: 100 },
  { column: 'flash_usage', min: 0, max: 100 }
];

const FCB_GROUND_STATION_SANITIZATION: SanitizationConfig = {
  state: { column: 'state', allowedStates: FCB_ALLOWED_STATES, stateNameColumn: 'state_name' },
  numericRanges: FCB_GROUND_STATION_NUMERIC_RANGES,
  gps: { latitudeColumn: 'latitude', longitudeColumn: 'longitude' }
};

export type FcbGroundStationSanitizationResult = {
  rows: string[][];
  summary: SanitizationSummary;
  validGpsRows: number;
};

export function sanitizeFcbGroundStationRows(
  headers: string[],
  rows: string[][],
  enabled: boolean
): FcbGroundStationSanitizationResult {
  const { rows: nextRows, summary } = sanitizeRows(headers, rows, FCB_GROUND_STATION_SANITIZATION, enabled);

  return {
    rows: nextRows,
    summary,
    validGpsRows: countValidGpsRows(headers, nextRows, 'latitude', 'longitude')
  };
}

export function applyFcbGroundStationSanitizationAttributes(
  attributes: Record<string, string>,
  result: FcbGroundStationSanitizationResult,
  enabled: boolean
) {
  attributes.valid_gps_rows = String(result.validGpsRows);
  applySanitizationAttributes(attributes, result.summary, enabled);
}
