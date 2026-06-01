/*
 * Event-window snapshot harness (renderer telemetry safety net).
 *
 * The parse snapshot only covers main-side importers. This harness exercises the
 * renderer detection logic (time axis + event markers + flight window) against
 * every fixture, for auto-detect on AND off, and hashes the derived launch/end/
 * event output. Used to prove the per-altimeter event-profile refactor (and
 * later phases) did not change detected events.
 *
 * Bundled by esbuild, run with: node <bundled>.cjs <label> | --diff a b
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getImporterById } from '../src/main/importers/registry';
import { buildXAxis } from '../src/renderer/src/telemetry/time';
import { buildEventMarkers, buildEventWindow } from '../src/renderer/src/telemetry/events';
import type { ImportedDataset } from '../src/renderer/src/importTypes';

const FLIGHT_DATA_DIR = path.resolve('flight-data');
const SNAPSHOT_DIR = path.resolve('.snapshots');
const ATTRIBUTES_FILE_NAME = 'attributes.csv';

type DatasetEvents = {
  dataset: string;
  importerId: string;
  hash: string;
  error?: string;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

async function readAttributes(altimeterDir: string): Promise<{ key: string; value: string }[]> {
  const contents = await readFile(path.join(altimeterDir, ATTRIBUTES_FILE_NAME), 'utf8');
  const rows = contents.split(/\r?\n/).filter((line) => line.length > 0).map(parseCsvLine);
  const dataRows = rows[0]?.[0] === 'key' && rows[0]?.[1] === 'value' ? rows.slice(1) : rows;
  return dataRows.filter((row) => row[0]).map((row) => ({ key: row[0] ?? '', value: row[1] ?? '' }));
}

async function listOriginalFilePaths(altimeterDir: string): Promise<string[]> {
  const entries = await readdir(altimeterDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase() !== ATTRIBUTES_FILE_NAME)
    .map((entry) => path.join(altimeterDir, entry.name));
}

function describeWindow(dataset: ImportedDataset, autoDetect: boolean) {
  const xAxis = buildXAxis(dataset, { autoDetect });
  const markers = buildEventMarkers(dataset, xAxis.values, { autoDetect });
  const window = buildEventWindow(dataset, xAxis.values, { autoDetect });
  return {
    autoDetect,
    title: xAxis.title,
    launchTime: markers.launchTime,
    flightStartTime: markers.flightStartTime,
    flightEndTime: markers.flightEndTime,
    events: markers.events.map((event) => ({ label: event.label, time: event.time, rowIndex: event.rowIndex })),
    window
  };
}

async function* walkAltimeterDirs(): AsyncGenerator<string> {
  const flights = await readdir(FLIGHT_DATA_DIR, { withFileTypes: true });
  for (const flight of flights) {
    if (!flight.isDirectory()) continue;
    const flightDir = path.join(FLIGHT_DATA_DIR, flight.name);
    const altimeters = await readdir(flightDir, { withFileTypes: true });
    for (const altimeter of altimeters) {
      if (altimeter.isDirectory()) yield path.join(flightDir, altimeter.name);
    }
  }
}

async function buildSnapshot(): Promise<DatasetEvents[]> {
  const snapshots: DatasetEvents[] = [];
  for await (const altimeterDir of walkAltimeterDirs()) {
    const datasetName = path.relative(FLIGHT_DATA_DIR, altimeterDir);
    let attributes: { key: string; value: string }[];
    try {
      attributes = await readAttributes(altimeterDir);
    } catch {
      continue;
    }
    const importerId = attributes.find((attribute) => attribute.key === 'importer_id')?.value ?? '';
    const importer = importerId ? getImporterById(importerId) : null;
    if (!importer) continue;
    try {
      const filePaths = await listOriginalFilePaths(altimeterDir);
      const parsed = await importer.parse(filePaths, { sanitize: true });
      const dataset: ImportedDataset = {
        summary: { attributes: { importer_id: importerId } } as ImportedDataset['summary'],
        attributes,
        headers: parsed.headers,
        rows: parsed.rows
      };
      const result = [describeWindow(dataset, true), describeWindow(dataset, false)];
      snapshots.push({
        dataset: datasetName,
        importerId,
        hash: createHash('sha256').update(JSON.stringify(result)).digest('hex')
      });
    } catch (error) {
      snapshots.push({ dataset: datasetName, importerId, hash: '', error: String(error) });
    }
  }
  return snapshots.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

async function loadSnapshot(label: string): Promise<DatasetEvents[]> {
  return JSON.parse(await readFile(path.join(SNAPSHOT_DIR, `${label}.json`), 'utf8')) as DatasetEvents[];
}

async function diff(labelA: string, labelB: string) {
  const [a, b] = await Promise.all([loadSnapshot(labelA), loadSnapshot(labelB)]);
  const byName = new Map(b.map((entry) => [entry.dataset, entry]));
  let differences = 0;
  for (const before of a) {
    const after = byName.get(before.dataset);
    if (!after) {
      console.log(`MISSING in ${labelB}: ${before.dataset}`);
      differences += 1;
    } else if (before.hash !== after.hash) {
      console.log(`EVENTS CHANGED: ${before.dataset} (${before.importerId})`);
      differences += 1;
    }
  }
  if (differences === 0) {
    console.log(`No event-window differences between "${labelA}" and "${labelB}" (${a.length} datasets).`);
  } else {
    console.log(`\n${differences} difference(s) found.`);
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  if (args[0] === '--diff') {
    await diff(args[1], args[2]);
    return;
  }
  const label = args[0] ?? 'events-baseline';
  const snapshot = await buildSnapshot();
  await writeFile(path.join(SNAPSHOT_DIR, `${label}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${snapshot.length} event snapshots to .snapshots/${label}.json`);
  for (const entry of snapshot.filter((item) => item.error)) {
    console.log(`  error: ${entry.dataset}: ${entry.error}`);
  }
}

void main();
