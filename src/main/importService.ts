import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAltimeterDefinition, getImporterForAltimeter } from './importers/registry';
import type { ImportPreview } from './importers/types';

export type FlightSummary = {
  directoryName: string;
  path: string;
  date: string;
  name: string;
  location: string;
  altimeterCount: number;
  peakAltitudeMeters: number | null;
  peakVelocityMs: number | null;
  peakAccelerationMss: number | null;
  altimeters: ImportedAltimeterSummary[];
};

export type CustomAttribute = {
  key: string;
  value: string;
};

export type ImportedAltimeterSummary = {
  id: string;
  flightDirectoryName: string;
  flightDate: string;
  flightName: string;
  flightLocation: string;
  altimeterDirectoryName: string;
  altimeterDirectory: string;
  altimeterName: string;
  altimeterNote: string;
  motor: string;
  flightNotes: string;
  peakAltitudeMeters: number | null;
  peakVelocityMs: number | null;
  peakAccelerationMss: number | null;
  rowCount: number;
  attributes: Record<string, string>;
};

export type ImportedDataset = {
  summary: ImportedAltimeterSummary;
  attributes: CustomAttribute[];
  headers: string[];
  rows: string[][];
};

export type SaveImportRequest = {
  altimeterId: string;
  filePaths: string[];
  flightMode: 'new' | 'existing';
  newFlight?: {
    date: string;
    name: string;
    location: string;
  };
  existingFlightDirectoryName?: string;
  flightLocation: string;
  altimeterNote: string;
  customAttributes: CustomAttribute[];
};

export type SaveImportResult = {
  outputDirectory: string;
  flightDirectory: string;
  altimeterDirectory: string;
  logPath: string;
  attributesPath: string;
  rowsWritten: number;
  dataset: ImportedAltimeterSummary;
};

export type AltimeterDetectionResult = {
  altimeterId: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason: string;
};

function sanitizePathSegment(value: string) {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  return sanitized || 'Untitled';
}

function csvCell(value: string) {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function csvLine(values: string[]) {
  return values.map((value) => csvCell(value)).join(',');
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function parseCsvRows(contents: string) {
  return contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => parseCsvLine(line));
}

async function readAttributes(attributesPath: string): Promise<CustomAttribute[]> {
  const contents = await readFile(attributesPath, 'utf8');
  const rows = parseCsvRows(contents);
  const dataRows = rows[0]?.[0] === 'key' && rows[0]?.[1] === 'value' ? rows.slice(1) : rows;

  return dataRows
    .filter((row) => row[0])
    .filter((row) => row[0] !== 'source_files')
    .map((row) => ({
      key: row[0] ?? '',
      value: row[1] ?? ''
    }));
}

async function writeAttributes(attributesPath: string, attributes: CustomAttribute[]) {
  const attributesCsv = [
    csvLine(['key', 'value']),
    ...attributes
      .filter((attribute) => attribute.key.trim())
      .map((attribute) => csvLine([attribute.key.trim(), attribute.value]))
  ].join('\n');

  await writeFile(attributesPath, `${attributesCsv}\n`, 'utf8');
}

async function copyOriginalFiles(filePaths: string[], destinationDirectory: string) {
  await mkdir(destinationDirectory, { recursive: true });
  const usedNames = new Set<string>();

  for (const filePath of filePaths) {
    const parsed = path.parse(filePath);
    let fileName = parsed.base;
    let copyIndex = 2;

    while (usedNames.has(fileName)) {
      fileName = `${parsed.name}-${copyIndex}${parsed.ext}`;
      copyIndex += 1;
    }

    usedNames.add(fileName);
    await copyFile(filePath, path.join(destinationDirectory, fileName));
  }
}

function attributesToRecord(attributes: CustomAttribute[]) {
  return attributes.reduce<Record<string, string>>((record, attribute) => {
    record[attribute.key] = attribute.value;
    return record;
  }, {});
}

type ColumnCandidate = { name: string; scale: number };

const ALTITUDE_COLUMNS: ColumnCandidate[] = [
  { name: 'altitudem', scale: 1 },
  { name: 'altitude_m', scale: 1 },
  { name: 'altitude', scale: 1 },
  { name: 'height', scale: 1 },
  { name: 'altitudeft', scale: 0.3048 },
  { name: 'altitude_ft', scale: 0.3048 }
];

const VELOCITY_COLUMNS: ColumnCandidate[] = [
  { name: 'velocityms', scale: 1 },
  { name: 'velocity_ms', scale: 1 },
  { name: 'velocityfts', scale: 0.3048 },
  { name: 'velocity_fts', scale: 0.3048 },
  { name: 'speed', scale: 1 }
];

const ACCELERATION_COLUMNS: ColumnCandidate[] = [
  { name: 'accelerationmss', scale: 1 },
  { name: 'acceleration_mss', scale: 1 },
  { name: 'acceleration', scale: 1 }
];

function findColumn(headers: string[], candidates: ColumnCandidate[]): { index: number; scale: number } | null {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate.name);
    if (index >= 0) {
      return { index, scale: candidate.scale };
    }
  }
  return null;
}

function computePeak(
  headers: string[],
  rows: string[][],
  candidates: ColumnCandidate[],
  options: { absolute: boolean }
): number | null {
  const column = findColumn(headers, candidates);
  if (!column) return null;

  let peak: number | null = null;
  for (const row of rows) {
    const raw = row[column.index];
    if (raw === undefined || raw === '') continue;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    const scaled = (options.absolute ? Math.abs(value) : value) * column.scale;
    if (peak === null || scaled > peak) peak = scaled;
  }
  return peak;
}

function computePeakAltitudeMeters(headers: string[], rows: string[][]): number | null {
  return computePeak(headers, rows, ALTITUDE_COLUMNS, { absolute: false });
}

function computePeakVelocityMs(headers: string[], rows: string[][]): number | null {
  return computePeak(headers, rows, VELOCITY_COLUMNS, { absolute: true });
}

function computePeakAccelerationMss(headers: string[], rows: string[][]): number | null {
  return computePeak(headers, rows, ACCELERATION_COLUMNS, { absolute: true });
}

function parseNumberAttribute(value: string | undefined): number | null {
  if (!value) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

async function readLog(logPath: string) {
  const contents = await readFile(logPath, 'utf8');
  const rows = parseCsvRows(contents);
  const headers = rows[0] ?? [];

  return {
    headers,
    rows: rows.slice(1)
  };
}

async function hasImportedAltimeter(altimeterDirectory: string) {
  try {
    await access(path.join(altimeterDirectory, 'log.csv'));
    await access(path.join(altimeterDirectory, 'attributes.csv'));
    return true;
  } catch {
    return false;
  }
}

function splitFlightDirectoryName(directoryName: string) {
  const match = directoryName.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);

  return {
    date: match?.[1] ?? '',
    name: match?.[2] ?? directoryName
  };
}

function resolveInsideOutputDirectory(outputDirectory: string, datasetDirectory: string) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const resolvedDatasetDirectory = path.resolve(datasetDirectory);
  const allowedPrefix = `${resolvedOutputDirectory}${path.sep}`;

  if (
    resolvedDatasetDirectory !== resolvedOutputDirectory &&
    !resolvedDatasetDirectory.startsWith(allowedPrefix)
  ) {
    throw new Error('Dataset path is outside the active flight data directory.');
  }

  return resolvedDatasetDirectory;
}

async function createImportedAltimeterSummary(
  outputDirectory: string,
  flightDirectoryName: string,
  altimeterDirectoryName: string
): Promise<ImportedAltimeterSummary | null> {
  const parsedFlight = splitFlightDirectoryName(flightDirectoryName);
  const altimeterDirectory = path.join(outputDirectory, flightDirectoryName, altimeterDirectoryName);
  const logPath = path.join(altimeterDirectory, 'log.csv');
  const attributesPath = path.join(altimeterDirectory, 'attributes.csv');

  if (!(await hasImportedAltimeter(altimeterDirectory))) {
    return null;
  }

  const attributes = attributesToRecord(await readAttributes(attributesPath));
  const log = await readLog(logPath);

  const peakAltitudeMeters =
    parseNumberAttribute(attributes.peak_altitude_m) ?? computePeakAltitudeMeters(log.headers, log.rows);
  const peakVelocityMs =
    parseNumberAttribute(attributes.peak_velocity_ms) ?? computePeakVelocityMs(log.headers, log.rows);
  const peakAccelerationMss =
    parseNumberAttribute(attributes.peak_acceleration_mss) ?? computePeakAccelerationMss(log.headers, log.rows);

  return {
    id: path.join(flightDirectoryName, altimeterDirectoryName),
    flightDirectoryName,
    flightDate: attributes.flight_date ?? parsedFlight.date,
    flightName: attributes.flight_name ?? parsedFlight.name,
    flightLocation: attributes.flight_location ?? '',
    altimeterDirectoryName,
    altimeterDirectory,
    altimeterName: attributes.altimeter_name ?? altimeterDirectoryName,
    altimeterNote: attributes.altimeter_note ?? '',
    motor: attributes.motor ?? '',
    flightNotes: attributes.flight_notes ?? '',
    peakAltitudeMeters,
    peakVelocityMs,
    peakAccelerationMss,
    rowCount: log.rows.length,
    attributes
  };
}

export async function ensureOutputDirectory(outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
}

export async function listFlights(outputDirectory: string): Promise<FlightSummary[]> {
  await ensureOutputDirectory(outputDirectory);

  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const flights: FlightSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const altimeterEntries = await readdir(path.join(outputDirectory, entry.name), {
      withFileTypes: true
    });
    const altimeters: ImportedAltimeterSummary[] = [];

    for (const altimeterEntry of altimeterEntries) {
      if (!altimeterEntry.isDirectory()) {
        continue;
      }

      const summary = await createImportedAltimeterSummary(outputDirectory, entry.name, altimeterEntry.name);

      if (summary) {
        altimeters.push(summary);
      }
    }

    if (altimeters.length === 0) {
      continue;
    }

    const parsed = splitFlightDirectoryName(entry.name);
    const maxOf = (selector: (a: ImportedAltimeterSummary) => number | null): number | null => {
      const values = altimeters.map(selector).filter((value): value is number => value !== null);
      return values.length > 0 ? Math.max(...values) : null;
    };

    flights.push({
      directoryName: entry.name,
      path: path.join(outputDirectory, entry.name),
      date: parsed.date,
      name: parsed.name,
      location: altimeters[0]?.flightLocation ?? '',
      altimeterCount: altimeters.length,
      peakAltitudeMeters: maxOf((a) => a.peakAltitudeMeters),
      peakVelocityMs: maxOf((a) => a.peakVelocityMs),
      peakAccelerationMss: maxOf((a) => a.peakAccelerationMss),
      altimeters
    });
  }

  return flights.sort((left, right) => right.directoryName.localeCompare(left.directoryName));
}

export async function readImportedDataset(
  outputDirectory: string,
  datasetDirectory: string
): Promise<ImportedDataset> {
  const altimeterDirectory = resolveInsideOutputDirectory(outputDirectory, datasetDirectory);
  const flightDirectory = path.dirname(altimeterDirectory);
  const flightDirectoryName = path.basename(flightDirectory);
  const altimeterDirectoryName = path.basename(altimeterDirectory);
  const summary = await createImportedAltimeterSummary(
    outputDirectory,
    flightDirectoryName,
    altimeterDirectoryName
  );

  if (!summary) {
    throw new Error('Dataset does not contain log.csv and attributes.csv.');
  }

  const attributes = await readAttributes(path.join(altimeterDirectory, 'attributes.csv'));
  const log = await readLog(path.join(altimeterDirectory, 'log.csv'));

  return {
    summary,
    attributes,
    headers: log.headers,
    rows: log.rows
  };
}

export async function saveImportedDatasetAttributes(
  outputDirectory: string,
  datasetDirectory: string,
  attributes: CustomAttribute[]
) {
  const altimeterDirectory = resolveInsideOutputDirectory(outputDirectory, datasetDirectory);
  const attributesPath = path.join(altimeterDirectory, 'attributes.csv');
  await writeAttributes(attributesPath, attributes);
  return readImportedDataset(outputDirectory, altimeterDirectory);
}

export async function previewImport(altimeterId: string, filePaths: string[]): Promise<ImportPreview> {
  const { importer } = getImporterForAltimeter(altimeterId);
  const parsed = await importer.parse(filePaths);

  return {
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    attributes: parsed.attributes,
    warnings: parsed.warnings,
    sourceFiles: parsed.sourceFiles
  };
}

function detectFromText(filePath: string, contents: string): AltimeterDetectionResult {
  const firstLines = contents.split(/\r?\n/).slice(0, 30).join('\n');
  const lowerFirstLines = firstLines.toLowerCase();

  if (
    lowerFirstLines.includes('perfectflite slcf') ||
    lowerFirstLines.includes('data: (time, altitude, velocity')
  ) {
    return {
      altimeterId: 'stratologgercf',
      confidence: 'high',
      reason: 'PerfectFlite SLCF text export detected.'
    };
  }

  if (lowerFirstLines.includes('timestamp,latitude,longitude,altitude')) {
    return {
      altimeterId: 'rawgpsdata',
      confidence: 'high',
      reason: 'RawGPSData CSV header detected.'
    };
  }

  if (
    lowerFirstLines.includes('#version,serial,flight,time,state,state_name') ||
    lowerFirstLines.includes('state_name,acceleration,pressure,altitude,height')
  ) {
    return {
      altimeterId: 'easymini',
      confidence: 'high',
      reason: 'AltOS CSV export detected.'
    };
  }

  if (
    lowerFirstLines.includes('timestampms') &&
    lowerFirstLines.includes('pressurepa') &&
    lowerFirstLines.includes('altitudem')
  ) {
    return {
      altimeterId: 'sillygoose',
      confidence: 'high',
      reason: 'SillyGoose header detected.'
    };
  }

  if (lowerFirstLines.includes('config\t') || lowerFirstLines.includes('config ')) {
    return {
      altimeterId: 'sillygoose',
      confidence: 'medium',
      reason: 'SillyGoose CONFIG line detected.'
    };
  }

  return {
    altimeterId: null,
    confidence: 'none',
    reason: 'No known altimeter format detected.'
  };
}

export async function detectAltimeter(filePaths: string[]): Promise<AltimeterDetectionResult> {
  for (const filePath of filePaths) {
    const contents = await readFile(filePath, 'utf8');
    const result = detectFromText(filePath, contents);

    if (result.altimeterId && getAltimeterDefinition(result.altimeterId)) {
      return result;
    }
  }

  return {
    altimeterId: null,
    confidence: 'none',
    reason: 'No known altimeter format detected.'
  };
}

export async function saveImport(
  outputDirectory: string,
  request: SaveImportRequest
): Promise<SaveImportResult> {
  await ensureOutputDirectory(outputDirectory);

  const { altimeter, importer } = getImporterForAltimeter(request.altimeterId);
  const parsed = await importer.parse(request.filePaths);

  if (parsed.rows.length === 0) {
    throw new Error('No data rows were found to import.');
  }

  const flightDirectoryName =
    request.flightMode === 'new'
      ? sanitizePathSegment(`${request.newFlight?.date ?? ''} ${request.newFlight?.name ?? ''}`)
      : sanitizePathSegment(request.existingFlightDirectoryName ?? '');

  const flightDate =
    request.flightMode === 'new'
      ? request.newFlight?.date ?? ''
      : splitFlightDirectoryName(flightDirectoryName).date;
  const flightName =
    request.flightMode === 'new'
      ? request.newFlight?.name ?? ''
      : splitFlightDirectoryName(flightDirectoryName).name;
  const flightLocation =
    request.flightMode === 'new' ? request.newFlight?.location ?? '' : request.flightLocation;

  const altimeterDirectoryName = sanitizePathSegment(
    `${altimeter.name}${request.altimeterNote.trim() ? ` ${request.altimeterNote.trim()}` : ''}`
  );
  const flightDirectory = path.join(outputDirectory, flightDirectoryName);
  const altimeterDirectory = path.join(flightDirectory, altimeterDirectoryName);
  const logPath = path.join(altimeterDirectory, 'log.csv');
  const attributesPath = path.join(altimeterDirectory, 'attributes.csv');

  await mkdir(flightDirectory, { recursive: true });

  try {
    await mkdir(altimeterDirectory);
  } catch {
    throw new Error(`An altimeter import already exists at ${altimeterDirectory}`);
  }

  const logCsv = [
    csvLine(parsed.headers),
    ...parsed.rows.map((row) => csvLine(row))
  ].join('\n');

  const attributes = new Map<string, string>();
  attributes.set('altimeter_name', altimeter.name);
  attributes.set('flight_location', flightLocation);
  attributes.set('flight_date', flightDate);
  attributes.set('flight_name', flightName);
  attributes.set('altimeter_note', request.altimeterNote.trim());
  attributes.set('importer_id', importer.id);
  attributes.set('imported_at', new Date().toISOString());

  const peakAltitudeMeters = computePeakAltitudeMeters(parsed.headers, parsed.rows);
  const peakVelocityMs = computePeakVelocityMs(parsed.headers, parsed.rows);
  const peakAccelerationMss = computePeakAccelerationMss(parsed.headers, parsed.rows);
  if (peakAltitudeMeters !== null) attributes.set('peak_altitude_m', peakAltitudeMeters.toFixed(2));
  if (peakVelocityMs !== null) attributes.set('peak_velocity_ms', peakVelocityMs.toFixed(2));
  if (peakAccelerationMss !== null) attributes.set('peak_acceleration_mss', peakAccelerationMss.toFixed(2));

  for (const attribute of request.customAttributes) {
    const key = attribute.key.trim();
    if (key) {
      attributes.set(key, attribute.value);
    }
  }

  await writeFile(logPath, `${logCsv}\n`, 'utf8');
  await writeAttributes(
    attributesPath,
    Array.from(attributes.entries()).map(([key, value]) => ({ key, value }))
  );
  await copyOriginalFiles(parsed.sourceFiles, path.join(altimeterDirectory, 'original-files'));

  const summary = await createImportedAltimeterSummary(
    outputDirectory,
    flightDirectoryName,
    altimeterDirectoryName
  );

  if (!summary) {
    throw new Error('Import saved, but the dataset could not be reopened.');
  }

  return {
    outputDirectory,
    flightDirectory,
    altimeterDirectory,
    logPath,
    attributesPath,
    rowsWritten: parsed.rows.length,
    dataset: summary
  };
}
