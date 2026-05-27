#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { parse: parseCsv } = require("csv-parse/sync");
const { getDataRoot, OVERVIEW_FILENAME, MANIFEST_FILENAME, USER_OVERRIDES_FILENAME } = require("../lib/flight-data");

const GENERATED_FILENAMES = new Set([OVERVIEW_FILENAME, MANIFEST_FILENAME, USER_OVERRIDES_FILENAME]);
const TIME_KEYS = ["time_s", "timestampms", "timestamp_ms", "time", "seconds", "unix_time_s", "timestamp"];

function sanitizePathPart(value, fallback = "unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function parseFlightName(dirName) {
  const match = String(dirName).match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if (!match) return { date: "unknown-date", flightName: sanitizePathPart(dirName, "unknown-flight") };
  return { date: match[1], flightName: sanitizePathPart(match[2], "unknown-flight") };
}

function listFlightDirectories(dataRoot) {
  if (!fs.existsSync(dataRoot)) return [];
  return fs
    .readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dataRoot, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function walkFiles(rootPath) {
  const files = [];
  function walk(current, relativeBase = "") {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (GENERATED_FILENAMES.has(entry.name)) continue;
      files.push({
        fullPath,
        fileName: entry.name,
        ext: path.extname(entry.name).toLowerCase(),
        relativePath: relativePath.split(path.sep).join("/"),
      });
    }
  }
  walk(rootPath);
  return files;
}

function parseTabularFile(filePath, ext) {
  if (![".csv", ".txt", ".tsv"].includes(ext)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const firstLine = content.split(/\r?\n/, 1)[0] || "";
  const candidates = [",", "\t", ";"];
  if (firstLine.includes("\t")) candidates.unshift("\t");

  for (const delimiter of candidates) {
    try {
      const rows = parseCsv(content, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
        delimiter,
      });
      if (!Array.isArray(rows) || !rows.length) continue;
      const columns = Object.keys(rows[0] || {});
      if (!columns.length) continue;
      return { rows, columns, delimiter };
    } catch (_error) {
      // Try next delimiter.
    }
  }
  return null;
}

function findTimeColumn(columns) {
  const lowerToOriginal = new Map(columns.map((column) => [String(column).toLowerCase(), column]));
  for (const key of TIME_KEYS) {
    if (lowerToOriginal.has(key)) return lowerToOriginal.get(key);
  }
  const regexMatch = columns.find((column) => /time|timestamp|unix/i.test(String(column)));
  return regexMatch || null;
}

function extractFcbVersion(corpus) {
  const explicit = corpus.match(/fcb\s*v?\s*([012])/i) || corpus.match(/fcbv([012])/i);
  if (explicit) return explicit[1];
  return null;
}

function yearFromDate(date) {
  const year = Number.parseInt(String(date || "").slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function isOnOrAfter(date, threshold) {
  const left = String(date || "");
  const right = String(threshold || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(left) || !/^\d{4}-\d{2}-\d{2}$/.test(right)) return false;
  return left >= right;
}

function detectBoardType({ candidateName, files, flightName, date }) {
  const corpus = `${flightName} ${candidateName} ${files.map((file) => file.fileName).join(" ")}`.toLowerCase();
  const year = yearFromDate(date);
  const fcbVersion = extractFcbVersion(corpus);
  const hasMetadataJson = files.some((file) => file.ext === ".json" && file.fileName.toLowerCase().includes("metadata"));

  // User rule: 2025-05-04 MBTA and everything after is SillyGoose.
  if (isOnOrAfter(date, "2025-05-04")) {
    if (corpus.includes("v2") || corpus.includes("sillygoosev2") || corpus.includes("sillygoose-v2")) return "SillyGooseV2";
    return "SillyGooseV1";
  }

  if (fcbVersion === "2") return "FCBV2";
  if (fcbVersion === "1") return "FCBV1";
  if (fcbVersion === "0") return "FCBV0";

  if (corpus.includes("angrygoose") || corpus.includes("angry goose")) return "AngryGoose";
  if (corpus.includes("ez mini") || corpus.includes("easymini") || corpus.includes("serial-")) return "EZMini";
  if (corpus.includes("stratologger") || corpus.includes("strat") || corpus.includes("perfectflite")) return "Stratologger";

  // Historical logs before 2025 that look like old FCB output are not SillyGoose boards.
  if (year !== null && year < 2025) {
    const looksLikeOldFcb = hasMetadataJson || corpus.includes("output-fcb-post") || corpus.includes("output-post") || corpus.includes("sillygoose");
    if (looksLikeOldFcb && fcbVersion !== null) return `FCBV${fcbVersion}`;
    if (looksLikeOldFcb) return "Unknown Altimeter";
  }

  if (corpus.includes("sillygoose") && corpus.includes("v2")) return "SillyGooseV2";
  if (corpus.includes("sillygoose")) return "SillyGooseV1";
  return "Unknown Altimeter";
}

function titleCaseWord(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function isBoardStyleFlightName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return true;
  return /^fcb\s*v?\s*[012]$/.test(normalized) || /^fcbv[012]$/.test(normalized);
}

function inferFlightLabel(flightName, files) {
  if (!isBoardStyleFlightName(flightName)) return flightName;

  const corpus = files.map((file) => file.fileName.toLowerCase()).join(" ");
  const directAndy = corpus.match(/\bandy\b/i);
  if (directAndy) return "Andy";

  const tokenCounts = new Map();
  const stop = new Set([
    "fcb",
    "v0",
    "v1",
    "v2",
    "output",
    "post",
    "metadata",
    "json",
    "csv",
    "txt",
    "flight",
    "serial",
    "easymini",
    "ez",
    "mini",
    "backup",
    "primary",
    "board",
    "goose",
    "sillygoose",
  ]);

  files.forEach((file) => {
    const base = path.basename(file.fileName, file.ext).toLowerCase();
    const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
    tokens.forEach((token) => {
      if (!/[a-z]/.test(token)) return;
      if (stop.has(token)) return;
      if (/^\d+$/.test(token)) return;
      if (token.length < 3) return;
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    });
  });

  const ranked = Array.from(tokenCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length) return "Unknown";
  return titleCaseWord(ranked[0][0]);
}

function pickBestDataFile(files) {
  const parsedCandidates = [];
  for (const file of files) {
    const parsed = parseTabularFile(file.fullPath, file.ext);
    if (!parsed) continue;
    const timeColumn = findTimeColumn(parsed.columns);
    const score = (timeColumn ? 1000 : 0) + parsed.rows.length + (file.fileName.toLowerCase().includes("output") ? 100 : 0);
    parsedCandidates.push({ file, parsed, timeColumn, score });
  }
  parsedCandidates.sort((a, b) => b.score - a.score);
  return parsedCandidates[0] || null;
}

function flattenObject(input, prefix = "", out = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const keyPart = String(rawKey).trim().replace(/\s+/g, "_").replace(/[^\w.\-]/g, "_");
    if (!keyPart) continue;
    const key = prefix ? `${prefix}.${keyPart}` : keyPart;
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      flattenObject(rawValue, key, out);
      continue;
    }
    out[key] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }
  return out;
}

function parseKeyValueText(filePath) {
  const out = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, 200);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim().replace(/\s+/g, "_").replace(/[^\w.\-]/g, "_");
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function readOverrides(flightPath) {
  const overridePath = path.join(flightPath, USER_OVERRIDES_FILENAME);
  if (!fs.existsSync(overridePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(overridePath, "utf8"));
  } catch (_error) {
    return {};
  }
}

function toTsv(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ");
}

function writeDataTsv(outputPath, parsedSelection) {
  const { rows, columns } = parsedSelection.parsed;
  const timeColumn = parsedSelection.timeColumn;
  const headers = [...columns];
  let syntheticTime = false;
  if (!timeColumn) {
    headers.unshift("generated_time_s");
    syntheticTime = true;
  }

  const lines = [headers.map(toTsv).join("\t")];
  rows.forEach((row, index) => {
    const values = headers.map((header) => {
      if (syntheticTime && header === "generated_time_s") return String(index);
      return toTsv(row[header]);
    });
    lines.push(values.join("\t"));
  });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return { timeColumn: timeColumn || "generated_time_s", rowCount: rows.length, syntheticTime };
}

function writePlaceholderDataTsv(outputPath) {
  fs.writeFileSync(outputPath, "generated_time_s\n", "utf8");
  return { timeColumn: "generated_time_s", rowCount: 0, syntheticTime: true };
}

function buildAttributeRows({ date, flightName, boardType, sourceFolder, selectedData, dataWriteInfo, files, overrides }) {
  const rows = [];
  const usedKeys = new Set();

  function pushAttribute(key, value, source) {
    if (value === null || value === undefined || String(value).trim() === "") return;
    let cleanKey = String(key).trim().replace(/\s+/g, "_").replace(/[^\w.\-]/g, "_");
    if (!cleanKey) return;
    if (usedKeys.has(cleanKey)) {
      let idx = 2;
      while (usedKeys.has(`${cleanKey}_${idx}`)) idx += 1;
      cleanKey = `${cleanKey}_${idx}`;
    }
    usedKeys.add(cleanKey);
    rows.push({ key: cleanKey, value: String(value), source });
  }

  pushAttribute("flight.date", date, "derived");
  pushAttribute("flight.name", flightName, "derived");
  pushAttribute("altimeter.board", boardType, "derived");
  pushAttribute("altimeter.source_folder", sourceFolder, "derived");
  pushAttribute("data.source_file", selectedData?.file?.relativePath || "none", "derived");
  pushAttribute("data.time_column", dataWriteInfo.timeColumn, "derived");
  pushAttribute("data.row_count", dataWriteInfo.rowCount, "derived");
  pushAttribute("data.synthetic_time_added", dataWriteInfo.syntheticTime ? "true" : "false", "derived");
  pushAttribute("data.has_parsed_timeseries", selectedData ? "true" : "false", "derived");

  for (const file of files) {
    if (selectedData?.file?.fullPath && file.fullPath === selectedData.file.fullPath) continue;
    if (file.ext === ".json") {
      try {
        const parsed = JSON.parse(fs.readFileSync(file.fullPath, "utf8"));
        const flat = flattenObject(parsed, `log.${path.basename(file.fileName, file.ext)}`);
        for (const [key, value] of Object.entries(flat)) pushAttribute(key, value, "log");
      } catch (_error) {
        // Ignore invalid JSON.
      }
      continue;
    }
    if (file.ext === ".txt") {
      const flat = parseKeyValueText(file.fullPath);
      for (const [key, value] of Object.entries(flat)) pushAttribute(`log.${path.basename(file.fileName, file.ext)}.${key}`, value, "log");
    }
  }

  const flightAttrs = overrides.flight?.attributes || {};
  for (const [key, value] of Object.entries(flightAttrs)) pushAttribute(`user.flight.${key}`, value, "user");
  if (overrides.flight?.notes) pushAttribute("user.flight.notes", overrides.flight.notes, "user");

  const altimeterOverride = overrides.altimeters?.[sourceFolder] || {};
  for (const [key, value] of Object.entries(altimeterOverride.attributeOverrides || {})) pushAttribute(`user.altimeter.${key}`, value, "user");
  if (altimeterOverride.notes) pushAttribute("user.altimeter.notes", altimeterOverride.notes, "user");
  if (altimeterOverride.displayName) pushAttribute("user.altimeter.display_name", altimeterOverride.displayName, "user");

  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function writeAttributesTsv(outputPath, rows) {
  const lines = ["key\tvalue\tsource"];
  rows.forEach((row) => {
    lines.push(`${toTsv(row.key)}\t${toTsv(row.value)}\t${toTsv(row.source)}`);
  });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function buildAltimeterCandidates(flightPath) {
  const entries = fs.readdirSync(flightPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const candidates = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || GENERATED_FILENAMES.has(entry.name)) continue;
    const fullPath = path.join(flightPath, entry.name);
    if (entry.isDirectory()) {
      candidates.push({ sourceFolder: entry.name, files: walkFiles(fullPath) });
      continue;
    }
    if (entry.isFile()) {
      candidates.push({
        sourceFolder: `root-${path.basename(entry.name, path.extname(entry.name))}`,
        files: [
          {
            fullPath,
            fileName: entry.name,
            ext: path.extname(entry.name).toLowerCase(),
            relativePath: entry.name,
          },
        ],
      });
    }
  }

  return candidates.filter((candidate) => candidate.files.length > 0);
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const sourceDataRoot = getDataRoot(repoRoot);
  const unifiedDataRoot = path.join(repoRoot, "data-unified");

  if (fs.existsSync(unifiedDataRoot)) fs.rmSync(unifiedDataRoot, { recursive: true, force: true });
  fs.mkdirSync(unifiedDataRoot, { recursive: true });

  const flights = listFlightDirectories(sourceDataRoot);
  let totalAltimeters = 0;
  let migratedAltimeters = 0;

  for (const flight of flights) {
    const { date, flightName } = parseFlightName(flight.name);
    const flightTargetDir = path.join(unifiedDataRoot, sanitizePathPart(flight.name));
    fs.mkdirSync(flightTargetDir, { recursive: true });

    const overrides = readOverrides(flight.path);
    const candidates = buildAltimeterCandidates(flight.path);
    const inferredFlightLabel = inferFlightLabel(
      flightName,
      candidates.flatMap((candidate) => candidate.files)
    );
    const folderUseCount = new Map();

    for (const candidate of candidates) {
      totalAltimeters += 1;
      const selectedData = pickBestDataFile(candidate.files);

      const boardType = detectBoardType({
        candidateName: candidate.sourceFolder,
        files: candidate.files,
        flightName,
        date,
      });
      const baseFolderName = sanitizePathPart(`${date} ${boardType} ${inferredFlightLabel}`);
      const count = (folderUseCount.get(baseFolderName) || 0) + 1;
      folderUseCount.set(baseFolderName, count);
      const folderName = count > 1 ? `${baseFolderName} ${String(count).padStart(2, "0")}` : baseFolderName;
      const outputDir = path.join(flightTargetDir, folderName);
      fs.mkdirSync(outputDir, { recursive: true });

      const dataPath = path.join(outputDir, "data.tsv");
      const attrPath = path.join(outputDir, "attributes.tsv");
      const dataWriteInfo = selectedData ? writeDataTsv(dataPath, selectedData) : writePlaceholderDataTsv(dataPath);
      const attributeRows = buildAttributeRows({
        date,
        flightName: inferredFlightLabel,
        boardType,
        sourceFolder: candidate.sourceFolder,
        selectedData,
        dataWriteInfo,
        files: candidate.files,
        overrides,
      });
      writeAttributesTsv(attrPath, attributeRows);
      migratedAltimeters += 1;
    }
  }

  console.log(`Source data root: ${sourceDataRoot}`);
  console.log(`Unified data root: ${unifiedDataRoot}`);
  console.log(`Flights processed: ${flights.length}`);
  console.log(`Altimeter candidates: ${totalAltimeters}`);
  console.log(`Altimeters migrated: ${migratedAltimeters}`);
}

main();
