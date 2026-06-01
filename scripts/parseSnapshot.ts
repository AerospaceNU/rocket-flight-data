/*
 * Parse-snapshot harness (refactor safety net).
 *
 * Walks every altimeter directory under flight-data/, parses the original
 * files with the registered importer, and records a stable hash of the parsed
 * headers + rows + parser attributes. Runs both sanitized and raw.
 *
 * Usage (bundled by scripts/run-snapshot.*):
 *   node <bundled>.cjs <label>
 * Writes .snapshots/<label>.json. Diff two labels with --diff a b.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getImporterById } from '../src/main/importers/registry';

const FLIGHT_DATA_DIR = path.resolve('flight-data');
const SNAPSHOT_DIR = path.resolve('.snapshots');
const ATTRIBUTES_FILE_NAME = 'attributes.csv';

type DatasetSnapshot = {
  dataset: string;
  importerId: string;
  sanitizedHash: string;
  rawHash: string;
  rowCount: number;
  headerCount: number;
  error?: string;
};

function hashParsed(parsed: { headers: string[]; rows: string[][]; attributes: Record<string, string> }) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parsed.headers));
  for (const row of parsed.rows) {
    hash.update(JSON.stringify(row));
  }
  // Parser-produced attributes only matter for parsing; derived metrics are not part of the importer output.
  hash.update(JSON.stringify(parsed.attributes));
  return hash.digest('hex');
}

async function readImporterId(altimeterDir: string): Promise<string | null> {
  try {
    const contents = await readFile(path.join(altimeterDir, ATTRIBUTES_FILE_NAME), 'utf8');
    const line = contents.split(/\r?\n/).find((row) => row.startsWith('importer_id,'));
    return line ? line.slice('importer_id,'.length).trim() : null;
  } catch {
    return null;
  }
}

async function listOriginalFilePaths(altimeterDir: string): Promise<string[]> {
  const entries = await readdir(altimeterDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase() !== ATTRIBUTES_FILE_NAME)
    .map((entry) => path.join(altimeterDir, entry.name));
}

async function* walkAltimeterDirs(): AsyncGenerator<string> {
  const flights = await readdir(FLIGHT_DATA_DIR, { withFileTypes: true });
  for (const flight of flights) {
    if (!flight.isDirectory()) continue;
    const flightDir = path.join(FLIGHT_DATA_DIR, flight.name);
    const altimeters = await readdir(flightDir, { withFileTypes: true });
    for (const altimeter of altimeters) {
      if (altimeter.isDirectory()) {
        yield path.join(flightDir, altimeter.name);
      }
    }
  }
}

async function buildSnapshot(): Promise<DatasetSnapshot[]> {
  const snapshots: DatasetSnapshot[] = [];
  for await (const altimeterDir of walkAltimeterDirs()) {
    const datasetName = path.relative(FLIGHT_DATA_DIR, altimeterDir);
    const importerId = await readImporterId(altimeterDir);
    if (!importerId) continue;
    const importer = getImporterById(importerId);
    if (!importer) {
      snapshots.push({ dataset: datasetName, importerId, sanitizedHash: '', rawHash: '', rowCount: 0, headerCount: 0, error: 'no importer' });
      continue;
    }
    try {
      const filePaths = await listOriginalFilePaths(altimeterDir);
      const sanitized = await importer.parse(filePaths, { sanitize: true });
      const raw = await importer.parse(filePaths, { sanitize: false });
      snapshots.push({
        dataset: datasetName,
        importerId,
        sanitizedHash: hashParsed(sanitized),
        rawHash: hashParsed(raw),
        rowCount: sanitized.rows.length,
        headerCount: sanitized.headers.length
      });
    } catch (error) {
      snapshots.push({ dataset: datasetName, importerId, sanitizedHash: '', rawHash: '', rowCount: 0, headerCount: 0, error: String(error) });
    }
  }
  return snapshots.sort((a, b) => a.dataset.localeCompare(b.dataset));
}

async function loadSnapshot(label: string): Promise<DatasetSnapshot[]> {
  const contents = await readFile(path.join(SNAPSHOT_DIR, `${label}.json`), 'utf8');
  return JSON.parse(contents) as DatasetSnapshot[];
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
      continue;
    }
    if (before.sanitizedHash !== after.sanitizedHash) {
      console.log(`SANITIZED CHANGED: ${before.dataset}`);
      differences += 1;
    }
    if (before.rawHash !== after.rawHash) {
      console.log(`RAW CHANGED: ${before.dataset}`);
      differences += 1;
    }
  }
  if (differences === 0) {
    console.log(`No parse differences between "${labelA}" and "${labelB}" (${a.length} datasets).`);
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

  const label = args[0] ?? 'baseline';
  try {
    await stat(FLIGHT_DATA_DIR);
  } catch {
    console.error(`flight-data directory not found at ${FLIGHT_DATA_DIR}`);
    process.exitCode = 1;
    return;
  }
  const snapshot = await buildSnapshot();
  await writeFile(path.join(SNAPSHOT_DIR, `${label}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const ok = snapshot.filter((entry) => !entry.error).length;
  console.log(`Wrote ${snapshot.length} datasets (${ok} parsed cleanly) to .snapshots/${label}.json`);
  for (const entry of snapshot.filter((item) => item.error)) {
    console.log(`  error: ${entry.dataset} (${entry.importerId}): ${entry.error}`);
  }
}

void main();
