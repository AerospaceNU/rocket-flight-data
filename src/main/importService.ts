import { access, copyFile, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getAltimeterDefinition,
  getImporterById,
  getImporterForAltimeter
} from './importers/registry';
import type { ImportPreview, ParsedImport } from './importers/types';
import type { StandardColumnMapping, StandardColumnRef } from '../shared/importConfig';
import { getStandardColumnsForImporter } from '../shared/importConfig';

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

const RESERVED_FILE_NAMES = new Set(['attributes.csv', 'log.csv']);

async function copyOriginalFiles(filePaths: string[], destinationDirectory: string) {
  await mkdir(destinationDirectory, { recursive: true });
  const usedNames = new Set<string>(RESERVED_FILE_NAMES);

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

async function listOriginalFilePaths(altimeterDirectory: string): Promise<string[]> {
  const entries = await readdir(altimeterDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !RESERVED_FILE_NAMES.has(entry.name))
    .map((entry) => path.join(altimeterDirectory, entry.name));
}

function attributesToRecord(attributes: CustomAttribute[]) {
  return attributes.reduce<Record<string, string>>((record, attribute) => {
    record[attribute.key] = attribute.value;
    return record;
  }, {});
}

function computePeakFromRef(
  headers: string[],
  rows: string[][],
  ref: StandardColumnRef | undefined,
  options: { absolute: boolean }
): number | null {
  if (!ref) return null;
  const index = headers.indexOf(ref.column);
  if (index < 0) return null;
  const scale = ref.scaleToStandard ?? 1;

  let peak: number | null = null;
  for (const row of rows) {
    const raw = row[index];
    if (raw === undefined || raw === '') continue;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    const scaled = (options.absolute ? Math.abs(value) : value) * scale;
    if (peak === null || scaled > peak) peak = scaled;
  }
  return peak;
}

function computeStandardPeaks(
  mapping: StandardColumnMapping | null,
  headers: string[],
  rows: string[][]
): {
  peakAltitudeMeters: number | null;
  peakVelocityMs: number | null;
  peakAccelerationMss: number | null;
} {
  if (!mapping) {
    return {
      peakAltitudeMeters: null,
      peakVelocityMs: null,
      peakAccelerationMss: null
    };
  }
  return {
    peakAltitudeMeters: computePeakFromRef(headers, rows, mapping.altitudeMeters, { absolute: false }),
    peakVelocityMs: computePeakFromRef(headers, rows, mapping.velocityMetersPerSecond, { absolute: true }),
    peakAccelerationMss: computePeakFromRef(
      headers,
      rows,
      mapping.accelerationMetersPerSecondSquared,
      { absolute: true }
    )
  };
}

function parseNumberAttribute(value: string | undefined): number | null {
  if (!value) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

async function hasImportedAltimeter(altimeterDirectory: string) {
  try {
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

type CachedMetrics = {
  rowCount: number;
  peakAltitudeMeters: number | null;
  peakVelocityMs: number | null;
  peakAccelerationMss: number | null;
};

const METRIC_ATTRIBUTE_KEYS = [
  'row_count',
  'peak_altitude_m',
  'peak_velocity_ms',
  'peak_acceleration_mss'
] as const;

function metricsFromAttributes(attributes: Record<string, string>): Partial<CachedMetrics> {
  const result: Partial<CachedMetrics> = {};
  const rowCount = parseNumberAttribute(attributes.row_count);
  if (rowCount !== null) result.rowCount = rowCount;
  if (attributes.peak_altitude_m !== undefined) {
    result.peakAltitudeMeters = parseNumberAttribute(attributes.peak_altitude_m);
  }
  if (attributes.peak_velocity_ms !== undefined) {
    result.peakVelocityMs = parseNumberAttribute(attributes.peak_velocity_ms);
  }
  if (attributes.peak_acceleration_mss !== undefined) {
    result.peakAccelerationMss = parseNumberAttribute(attributes.peak_acceleration_mss);
  }
  return result;
}

function computeMetricsFromParsed(
  parsed: { headers: string[]; rows: string[][] },
  mapping: StandardColumnMapping | null
): CachedMetrics {
  const peaks = computeStandardPeaks(mapping, parsed.headers, parsed.rows);
  return {
    rowCount: parsed.rows.length,
    ...peaks
  };
}

async function parseAltimeterOriginals(
  altimeterDirectory: string,
  importerId: string
): Promise<ParsedImport> {
  const importer = getImporterById(importerId);
  if (!importer) {
    throw new Error(`No importer registered for id: ${importerId}`);
  }
  const filePaths = await listOriginalFilePaths(altimeterDirectory);
  if (filePaths.length === 0) {
    throw new Error(`No original files found in ${altimeterDirectory}`);
  }
  return importer.parse(filePaths);
}

async function readSavedLogDataset(
  altimeterDirectory: string
): Promise<{ headers: string[]; rows: string[][] } | null> {
  const logPath = path.join(altimeterDirectory, 'log.csv');
  try {
    await access(logPath);
  } catch {
    return null;
  }

  const contents = await readFile(logPath, 'utf8');
  const parsedRows = parseCsvRows(contents);
  if (parsedRows.length === 0) {
    return null;
  }

  const headers = parsedRows[0]?.map((header) => header.trim()) ?? [];
  const rows = parsedRows
    .slice(1)
    .filter((row) => row.some((cell) => cell.length > 0))
    .map((row) => headers.map((_, index) => row[index] ?? ''));

  if (headers.length === 0) {
    return null;
  }

  return { headers, rows };
}

async function readDatasetRows(
  altimeterDirectory: string,
  importerId: string
): Promise<{ headers: string[]; rows: string[][] }> {
  const savedLog = await readSavedLogDataset(altimeterDirectory);
  if (savedLog) {
    return savedLog;
  }

  const parsed = await parseAltimeterOriginals(altimeterDirectory, importerId);
  return { headers: parsed.headers, rows: parsed.rows };
}

async function resolveDatasetImporterId(
  altimeterDirectory: string,
  storedImporterId: string
): Promise<string> {
  const filePaths = await listOriginalFilePaths(altimeterDirectory);
  if (filePaths.length === 0) {
    return storedImporterId;
  }

  const detected = await detectAltimeter(filePaths);
  if (!detected.altimeterId || detected.confidence !== 'high') {
    return storedImporterId;
  }

  try {
    return getImporterForAltimeter(detected.altimeterId).importer.id;
  } catch {
    return storedImporterId;
  }
}

function replaceAttribute(attributes: CustomAttribute[], key: string, value: string): CustomAttribute[] {
  let replaced = false;
  const next = attributes.map((attribute) => {
    if (attribute.key !== key) return attribute;
    replaced = true;
    return { key, value };
  });

  return replaced ? next : [...next, { key, value }];
}

async function writeSavedLogDataset(
  altimeterDirectory: string,
  headers: string[],
  rows: string[][]
): Promise<void> {
  const logPath = path.join(altimeterDirectory, 'log.csv');
  const csvContents = [csvLine(headers), ...rows.map((row) => csvLine(row))].join('\n');
  await writeFile(logPath, `${csvContents}\n`, 'utf8');
}

async function resolveMetrics(
  altimeterDirectory: string,
  attributesPath: string,
  attributes: Record<string, string>
): Promise<{ metrics: CachedMetrics; attributes: Record<string, string> }> {
  const importerId = attributes.importer_id;
  const mapping = importerId ? getStandardColumnsForImporter(importerId) : null;
  const cached = metricsFromAttributes(attributes);

  // If the importer's mapping defines a metric but it's not yet cached, force a recompute
  // (catches legacy imports written before the mapping existed).
  const altitudeStale = !!mapping?.altitudeMeters && cached.peakAltitudeMeters === undefined;
  const velocityStale =
    !!mapping?.velocityMetersPerSecond && cached.peakVelocityMs === undefined;
  const accelStale =
    !!mapping?.accelerationMetersPerSecondSquared && cached.peakAccelerationMss === undefined;
  const rowCountStale = cached.rowCount === undefined;
  const needsRefresh = rowCountStale || altitudeStale || velocityStale || accelStale;

  if (!needsRefresh) {
    return {
      metrics: {
        rowCount: cached.rowCount ?? 0,
        peakAltitudeMeters: cached.peakAltitudeMeters ?? null,
        peakVelocityMs: cached.peakVelocityMs ?? null,
        peakAccelerationMss: cached.peakAccelerationMss ?? null
      },
      attributes
    };
  }

  if (!importerId) {
    return {
      metrics: {
        rowCount: 0,
        peakAltitudeMeters: null,
        peakVelocityMs: null,
        peakAccelerationMss: null
      },
      attributes
    };
  }

  const parsed = await readDatasetRows(altimeterDirectory, importerId);
  const metrics = computeMetricsFromParsed(parsed, mapping);

  const nextAttributes = { ...attributes };
  nextAttributes.row_count = String(metrics.rowCount);
  if (metrics.peakAltitudeMeters !== null) {
    nextAttributes.peak_altitude_m = metrics.peakAltitudeMeters.toFixed(2);
  }
  if (metrics.peakVelocityMs !== null) {
    nextAttributes.peak_velocity_ms = metrics.peakVelocityMs.toFixed(2);
  }
  if (metrics.peakAccelerationMss !== null) {
    nextAttributes.peak_acceleration_mss = metrics.peakAccelerationMss.toFixed(2);
  }

  await writeAttributes(
    attributesPath,
    Object.entries(nextAttributes).map(([key, value]) => ({ key, value }))
  );

  return { metrics, attributes: nextAttributes };
}

async function createImportedAltimeterSummary(
  outputDirectory: string,
  flightDirectoryName: string,
  altimeterDirectoryName: string
): Promise<ImportedAltimeterSummary | null> {
  const parsedFlight = splitFlightDirectoryName(flightDirectoryName);
  const altimeterDirectory = path.join(outputDirectory, flightDirectoryName, altimeterDirectoryName);
  const attributesPath = path.join(altimeterDirectory, 'attributes.csv');

  if (!(await hasImportedAltimeter(altimeterDirectory))) {
    return null;
  }

  const initialAttributes = attributesToRecord(await readAttributes(attributesPath));
  const { metrics, attributes } = await resolveMetrics(altimeterDirectory, attributesPath, initialAttributes);

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
    peakAltitudeMeters: metrics.peakAltitudeMeters,
    peakVelocityMs: metrics.peakVelocityMs,
    peakAccelerationMss: metrics.peakAccelerationMss,
    rowCount: metrics.rowCount,
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
    throw new Error('Dataset is missing attributes.csv.');
  }

  const attributes = await readAttributes(path.join(altimeterDirectory, 'attributes.csv'));
  const storedImporterId = summary.attributes.importer_id;
  if (!storedImporterId) {
    throw new Error('Dataset is missing importer_id attribute; cannot parse originals.');
  }

  const importerId = await resolveDatasetImporterId(altimeterDirectory, storedImporterId);
  const parsed = await readDatasetRows(altimeterDirectory, importerId);
  const effectiveAttributes =
    importerId === storedImporterId ? attributes : replaceAttribute(attributes, 'importer_id', importerId);
  const effectiveSummary =
    importerId === storedImporterId
      ? summary
      : {
          ...summary,
          attributes: {
            ...summary.attributes,
            importer_id: importerId
          }
        };

  return {
    summary: effectiveSummary,
    attributes: effectiveAttributes,
    headers: parsed.headers,
    rows: parsed.rows
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

function detectFromText(contents: string): AltimeterDetectionResult {
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
    lowerFirstLines.includes('packettype') &&
    lowerFirstLines.includes('timestamp_ms') &&
    lowerFirstLines.includes('imu1_accel_x')
  ) {
    return {
      altimeterId: 'fcb',
      confidence: 'high',
      reason: 'FCB CSV header detected.'
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
    const handle = await open(filePath, 'r');
    let contents = '';
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      contents = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const result = detectFromText(contents);

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
  const attributesPath = path.join(altimeterDirectory, 'attributes.csv');

  await mkdir(flightDirectory, { recursive: true });

  try {
    await mkdir(altimeterDirectory);
  } catch {
    throw new Error(`An altimeter import already exists at ${altimeterDirectory}`);
  }

  const attributes = new Map<string, string>();
  attributes.set('altimeter_name', altimeter.name);
  attributes.set('flight_location', flightLocation);
  attributes.set('flight_date', flightDate);
  attributes.set('flight_name', flightName);
  attributes.set('altimeter_note', request.altimeterNote.trim());
  attributes.set('importer_id', importer.id);
  attributes.set('imported_at', new Date().toISOString());
  attributes.set('row_count', String(parsed.rows.length));

  const peaks = computeStandardPeaks(altimeter.standardColumns, parsed.headers, parsed.rows);
  if (peaks.peakAltitudeMeters !== null) attributes.set('peak_altitude_m', peaks.peakAltitudeMeters.toFixed(2));
  if (peaks.peakVelocityMs !== null) attributes.set('peak_velocity_ms', peaks.peakVelocityMs.toFixed(2));
  if (peaks.peakAccelerationMss !== null) {
    attributes.set('peak_acceleration_mss', peaks.peakAccelerationMss.toFixed(2));
  }

  for (const attribute of request.customAttributes) {
    const key = attribute.key.trim();
    if (key) {
      attributes.set(key, attribute.value);
    }
  }

  await copyOriginalFiles(parsed.sourceFiles, altimeterDirectory);
  await writeSavedLogDataset(altimeterDirectory, parsed.headers, parsed.rows);
  await writeAttributes(
    attributesPath,
    Array.from(attributes.entries()).map(([key, value]) => ({ key, value }))
  );

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
    attributesPath,
    rowsWritten: parsed.rows.length,
    dataset: summary
  };
}
