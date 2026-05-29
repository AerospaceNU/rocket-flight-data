import { readFile } from 'node:fs/promises';
import type { AltimeterImporter, ParsedImport } from './types';

const FCB_GROUND_STATION_HEADERS = [
  'timestamp_ms',
  'log_time',
  'radio_id',
  'radio_name',
  'rssi_db',
  'lqi',
  'crc',
  'software_version',
  'board_serial_number',
  'callsign',
  'state',
  'state_name',
  'temperature_c',
  'altitude_m',
  'velocity_m_s',
  'latitude',
  'longitude',
  'gps_altitude_m',
  'battery_v',
  'ground_speed_m_s',
  'course_deg',
  'gps_sats',
  'gps_time',
  'ble_client',
  'accel_x_m_s2',
  'accel_y_m_s2',
  'accel_z_m_s2',
  'accel_total_m_s2',
  'gyro_x_rad_s',
  'gyro_y_rad_s',
  'gyro_z_rad_s',
  'magnetic_x',
  'magnetic_y',
  'magnetic_z',
  'angle_vertical_deg',
  'roll_rad',
  'pitch_rad',
  'yaw_rad',
  'q_x',
  'q_y',
  'q_z',
  'q_w',
  'barometer_pressure',
  'barometer_2_pressure',
  'pressure_ref',
  'ground_elev_m',
  'ground_temp_c',
  'pitot_ducer_press',
  'pyro_continuity',
  'pyro_status',
  'flash_usage'
];

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

const SUPPORTED_PACKET_TYPES = new Set(['Position Data', 'Orientation', 'Alt Info & Cfg', 'Pyro Info']);

type RowRecord = Record<string, string>;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function packetTypeFromLine(prefix: string) {
  return prefix.trim().replace(/\s+/g, ' ');
}

function packetLine(line: string) {
  const match = line.match(/^(\d{2}:\d{2}:\d{2}(?:\.\d+)?):\s*(.*?)\s*(\{.*\})\s*$/);
  if (!match) return null;

  return {
    logTime: match[1],
    packetType: packetTypeFromLine(match[2]),
    body: match[3]
  };
}

function readNumber(body: string, key: string) {
  const match = body.match(
    new RegExp(`['"]${escapeRegExp(key)}['"]\\s*:\\s*([-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)`)
  );
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readRawValue(body: string, key: string) {
  const match = body.match(
    new RegExp(
      `['"]${escapeRegExp(key)}['"]\\s*:\\s*('(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"|\\[[^\\]]*\\]|[^,}]+)`
    )
  );
  return match?.[1]?.trim() ?? null;
}

function readString(body: string, key: string) {
  const raw = readRawValue(body, key);
  if (raw === null || raw === 'None') return null;
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    return raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  return raw;
}

function readQuaternion(body: string) {
  const raw = readRawValue(body, 'orientation_quaternion');
  if (!raw?.startsWith('[') || !raw.endsWith(']')) return null;
  const values = raw
    .slice(1, -1)
    .split(',')
    .map((value) => Number.parseFloat(value.trim()));
  return values.length >= 4 && values.every(Number.isFinite) ? values : null;
}

function rssiDb(body: string) {
  const numeric = readNumber(body, 'rssi');
  if (numeric !== null) return numeric;
  const text = readString(body, 'rssi');
  if (!text) return null;
  const parsed = Number.parseFloat(text.replace(/db/i, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function setNumber(row: RowRecord, key: string, value: number | null) {
  if (value !== null) row[key] = String(value);
}

function setValue(row: RowRecord, key: string, value: string | null) {
  if (value !== null) row[key] = value;
}

function getRow(rowsByTimestamp: Map<number, RowRecord>, timestamp: number, logTime: string) {
  let row = rowsByTimestamp.get(timestamp);
  if (!row) {
    row = {
      timestamp_ms: String(timestamp),
      log_time: logTime
    };
    rowsByTimestamp.set(timestamp, row);
  } else if (!row.log_time) {
    row.log_time = logTime;
  }
  return row;
}

function applyCommonRadioFields(row: RowRecord, body: string) {
  setNumber(row, 'radio_id', readNumber(body, 'radio_id'));
  setValue(row, 'radio_name', readString(body, 'radio_name'));
  setNumber(row, 'rssi_db', rssiDb(body));
  setNumber(row, 'lqi', readNumber(body, 'lqi'));
  setValue(row, 'crc', readString(body, 'crc'));
  setNumber(row, 'software_version', readNumber(body, 'software_version'));
  setNumber(row, 'board_serial_number', readNumber(body, 'board_serial_number'));
  setValue(row, 'callsign', readString(body, 'callsign'));

  const state = readNumber(body, 'fcb_state_number');
  if (state !== null) {
    row.state = String(state);
    row.state_name = FCB_STATE_NAMES[state] ?? '';
  }
}

function applyPositionPacket(row: RowRecord, body: string) {
  setNumber(row, 'temperature_c', readNumber(body, 'temperature'));
  setNumber(row, 'altitude_m', readNumber(body, 'fcb_altitude'));
  setNumber(row, 'velocity_m_s', readNumber(body, 'v_speed'));
  setNumber(row, 'latitude', readNumber(body, 'fcb_latitude'));
  setNumber(row, 'longitude', readNumber(body, 'fcb_longitude'));
  setNumber(row, 'gps_altitude_m', readNumber(body, 'gps_alt'));
  setNumber(row, 'battery_v', readNumber(body, 'fcb_battery_voltage'));
  setNumber(row, 'ground_speed_m_s', readNumber(body, 'ground_speed'));
  setNumber(row, 'course_deg', readNumber(body, 'course_over_ground'));
  setNumber(row, 'gps_sats', readNumber(body, 'gps_sats'));
  setValue(row, 'gps_time', readString(body, 'gps_time'));
  setNumber(row, 'ble_client', readNumber(body, 'ble_client'));
}

function applyOrientationPacket(row: RowRecord, body: string) {
  const accelX = readNumber(body, 'accel_x');
  const accelY = readNumber(body, 'accel_y');
  const accelZ = readNumber(body, 'accel_z');

  setNumber(row, 'accel_x_m_s2', accelX);
  setNumber(row, 'accel_y_m_s2', accelY);
  setNumber(row, 'accel_z_m_s2', accelZ);
  if (accelX !== null && accelY !== null && accelZ !== null) {
    row.accel_total_m_s2 = String(Math.hypot(accelX, accelY, accelZ));
  }

  setNumber(row, 'gyro_x_rad_s', readNumber(body, 'rot_vel_x'));
  setNumber(row, 'gyro_y_rad_s', readNumber(body, 'rot_vel_y'));
  setNumber(row, 'gyro_z_rad_s', readNumber(body, 'rot_vel_z'));
  setNumber(row, 'magnetic_x', readNumber(body, 'magnetic_field_x'));
  setNumber(row, 'magnetic_y', readNumber(body, 'magnetic_field_y'));
  setNumber(row, 'magnetic_z', readNumber(body, 'magnetic_field_z'));
  setNumber(row, 'angle_vertical_deg', readNumber(body, 'angle_vertical'));
  setNumber(row, 'roll_rad', readNumber(body, 'roll'));
  setNumber(row, 'pitch_rad', readNumber(body, 'pitch'));
  setNumber(row, 'yaw_rad', readNumber(body, 'yaw'));

  const quaternion = readQuaternion(body);
  if (quaternion) {
    // Ground-station logs store quaternion as [w, x, y, z].
    setNumber(row, 'q_w', quaternion[0]);
    setNumber(row, 'q_x', quaternion[1]);
    setNumber(row, 'q_y', quaternion[2]);
    setNumber(row, 'q_z', quaternion[3]);
  }
}

function applyAltInfoPacket(row: RowRecord, body: string) {
  setNumber(row, 'barometer_pressure', readNumber(body, 'barometer_pressure'));
  setNumber(row, 'barometer_2_pressure', readNumber(body, 'barometer_2_pressure'));
  setNumber(row, 'pressure_ref', readNumber(body, 'press_ref'));
  setNumber(row, 'ground_elev_m', readNumber(body, 'ground_elev'));
  setNumber(row, 'ground_temp_c', readNumber(body, 'ground_temp'));
  setNumber(row, 'pitot_ducer_press', readNumber(body, 'pitot_ducer_press'));
}

function applyPyroPacket(row: RowRecord, body: string) {
  setValue(row, 'pyro_continuity', readString(body, 'pyro_continuity'));
  setValue(row, 'pyro_status', readString(body, 'pyro_status'));
  setNumber(row, 'flash_usage', readNumber(body, 'flash_usage'));
}

function applyPacket(row: RowRecord, packetType: string, body: string) {
  applyCommonRadioFields(row, body);

  if (packetType === 'Position Data') {
    applyPositionPacket(row, body);
  } else if (packetType === 'Orientation') {
    applyOrientationPacket(row, body);
  } else if (packetType === 'Alt Info & Cfg') {
    applyAltInfoPacket(row, body);
  } else if (packetType === 'Pyro Info') {
    applyPyroPacket(row, body);
  }
}

function validGps(row: RowRecord) {
  const latitude = Number.parseFloat(row.latitude);
  const longitude = Number.parseFloat(row.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    Math.abs(latitude) > 0.001 &&
    Math.abs(longitude) > 0.001
  );
}

function normalizedPacketCountKey(packetType: string) {
  return packetType.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export const fcbGroundStationImporter: AltimeterImporter = {
  id: 'fcbgroundstation',
  name: 'FCBGroundStation',
  async parse(filePaths: string[]): Promise<ParsedImport> {
    const rowsByTimestamp = new Map<number, RowRecord>();
    const attributes: Record<string, string> = {
      source_format: 'FCB Ground Station parsed log',
      sanitized_source: 'true',
      time_units: 'ms',
      altitude_units: 'm',
      velocity_units: 'm/s',
      acceleration_units: 'm/s^2'
    };
    const warnings: string[] = [];
    const packetCounts = new Map<string, number>();
    let fileCount = 0;
    let malformedCount = 0;

    for (const filePath of filePaths) {
      const contents = await readFile(filePath, 'utf8');
      fileCount += 1;

      for (const line of contents.split(/\r?\n/)) {
        const runStartMatch = line.match(/^RUN START\s+(.+)$/);
        if (runStartMatch && !attributes.run_start) {
          attributes.run_start = runStartMatch[1].trim();
          continue;
        }

        const packet = packetLine(line);
        if (!packet) continue;

        packetCounts.set(packet.packetType, (packetCounts.get(packet.packetType) ?? 0) + 1);
        if (!SUPPORTED_PACKET_TYPES.has(packet.packetType)) continue;

        const timestamp = readNumber(packet.body, 'time_stamp_ms');
        if (timestamp === null) {
          malformedCount += 1;
          continue;
        }

        const timestampMs = Math.round(timestamp);
        const row =
          packet.packetType === 'Position Data' || packet.packetType === 'Orientation'
            ? getRow(rowsByTimestamp, timestampMs, packet.logTime)
            : rowsByTimestamp.get(timestampMs);
        if (!row) continue;

        applyPacket(row, packet.packetType, packet.body);
      }
    }

    const sortedRows = Array.from(rowsByTimestamp.values()).sort(
      (left, right) => Number(left.timestamp_ms) - Number(right.timestamp_ms)
    );
    const rows = sortedRows.map((row) => FCB_GROUND_STATION_HEADERS.map((header) => row[header] ?? ''));

    attributes.source_file_count = String(fileCount);
    attributes.packet_counts = JSON.stringify(Object.fromEntries(packetCounts.entries()));
    attributes.valid_gps_rows = String(sortedRows.filter(validGps).length);
    attributes.bad_rows_removed = '0';
    attributes.bad_gps_values_blanked = '0';
    attributes.bad_numeric_values_blanked = '0';
    attributes.bad_state_values_blanked = '0';
    if (sortedRows[0]) {
      attributes.start_timestamp_ms = sortedRows[0].timestamp_ms;
      attributes.end_timestamp_ms = sortedRows[sortedRows.length - 1].timestamp_ms;
    }

    if (malformedCount > 0) {
      warnings.push(`Skipped ${malformedCount} malformed packet line(s).`);
    }
    if (rows.length === 0) {
      warnings.push('No FCBGroundStation telemetry rows were found in the selected file(s).');
    }

    for (const [packetType, count] of packetCounts.entries()) {
      if (count > 0 && !SUPPORTED_PACKET_TYPES.has(packetType)) {
        attributes[`packet_count_${normalizedPacketCountKey(packetType)}`] = String(count);
      }
    }

    return {
      headers: FCB_GROUND_STATION_HEADERS,
      rows,
      attributes,
      warnings,
      sourceFiles: filePaths
    };
  }
};
