const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parse: parseCsv } = require("csv-parse/sync");

const OVERVIEW_FILENAME = ".flight-overview.json";
const MANIFEST_FILENAME = ".flight-index-manifest.json";
const USER_OVERRIDES_FILENAME = ".flight-user-overrides.json";
const FLIGHT_ATTRIBUTES_SCHEMA_PATH = path.resolve(__dirname, "..", "config", "flight-attributes.json");
const FILE_INTERFACES_DIR = path.join(__dirname, "file-interfaces");
const INDEXER_VERSION = "2026-05-26-v4";

const GENERATED_FILENAMES = new Set([OVERVIEW_FILENAME, USER_OVERRIDES_FILENAME]);
const ALTITUDE_KEYS = ["altitudeM", "altitude_m", "altitude", "height", "gps_alt", "unfiltAlt", "pos_z", "altitude_ft"];
const SPEED_KEYS = ["velocityMS", "velocity", "speed", "vel_z", "vtg", "velocity_ft_s"];
const ACCELERATION_KEYS = [
  "accelerationMSS",
  "acceleration",
  "high_g_accel_z_real",
  "acc_z",
  "accelZ",
  "imu_accel_z_avg",
];
const LAT_KEYS = ["gps_lat_mod", "gps_lat", "lat", "latitude"];
const LON_KEYS = ["gps_long_mod", "gps_long", "lon", "long", "longitude"];
const TIME_KEYS = ["time_s", "timestampMs", "timestamp_ms", "time", "seconds", "unix_time_s", "timestamp"];
const RESERVED_ATTRIBUTE_KEYS = new Set([
  "altimeter.id",
  "altimeter.interface",
  "altimeter.device_types",
  "flight.date",
  "flight.rocket_name",
  "data.file_name",
  "data.relative_path",
  "data.format",
  "data.row_count",
  "data.time_column",
  "data.time_start_s",
  "data.time_end_s",
  "data.max_altitude",
  "data.max_speed",
  "data.has_3d_path",
]);

const ALTIMETER_INTERFACES = [
  {
    id: "sillygoose",
    label: "SillyGoose",
    supports(files) {
      return files.some((file) => file.deviceType === "sillygoose");
    },
  },
  {
    id: "easymini",
    label: "EasyMini",
    supports(files) {
      return files.some((file) => file.deviceType === "easymini" || file.deviceType === "easymini-eeprom");
    },
  },
  {
    id: "perfectflite",
    label: "PerfectFlite",
    supports(files) {
      return files.some((file) => file.deviceType === "perfectflite");
    },
  },
  {
    id: "linecutter",
    label: "Line Cutter",
    supports(files) {
      return files.some((file) => file.deviceType === "linecutter");
    },
  },
  {
    id: "gps",
    label: "GPS",
    supports(files) {
      return files.some((file) => file.deviceType === "gps");
    },
  },
  {
    id: "groundstation",
    label: "Ground Station",
    supports(files) {
      return files.some((file) => file.deviceType === "groundstation");
    },
  },
  {
    id: "generic-tabular",
    label: "Generic Tabular",
    supports(files) {
      return files.some((file) => file.parseKind === "tabular");
    },
  },
];

function getDataRoot(repoRoot) {
  return path.join(repoRoot, "data");
}

function parseFlightDirectoryName(dirName) {
  const match = dirName.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if (!match) {
    return {
      date: null,
      year: null,
      rocketName: dirName,
    };
  }
  return {
    date: match[1],
    year: Number.parseInt(match[1].slice(0, 4), 10),
    rocketName: match[2].trim(),
  };
}

function listFlightDirectories(dataRoot) {
  if (!fs.existsSync(dataRoot)) return [];
  return fs
    .readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dataRoot, entry.name),
      info: parseFlightDirectoryName(entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadManifest(dataRoot) {
  const manifestPath = path.join(dataRoot, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return { indexerVersion: INDEXER_VERSION, flights: {} };
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    return {
      indexerVersion: manifest.indexerVersion || null,
      flights: manifest.flights && typeof manifest.flights === "object" ? manifest.flights : {},
    };
  } catch (_error) {
    return { indexerVersion: INDEXER_VERSION, flights: {} };
  }
}

function saveManifest(dataRoot, manifest) {
  const manifestPath = path.join(dataRoot, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function safeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function splitLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeHeader(value, index) {
  const text = String(value || "")
    .trim()
    .replace(/^"+|"+$/g, "");
  if (!text) return `column_${index + 1}`;
  return text;
}

function findFirstExistingKey(columns, keys) {
  const set = new Set(columns);
  for (const key of keys) {
    if (set.has(key)) return key;
  }
  return null;
}

function sanitizeSlug(value, fallback = "group") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function titleCaseFromSlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeStemForMatching(stem) {
  return sanitizeSlug(
    String(stem || "")
      .replace(/-metadata$/i, "")
      .replace(/-output-fcb-post$/i, "")
      .replace(/-output-post$/i, "")
      .replace(/-recovered-output-post$/i, "")
      .replace(/-output-linecutter$/i, "")
      .replace(/-groundstation(?:-logs)?$/i, "")
      .replace(/[_ ]groundstation(?: logs)?$/i, "")
      .replace(/groundstationdatainterface_parsed$/i, "")
      .replace(/parsed_messages$/i, "")
      .replace(/-parsed$/i, "")
  );
}

function cleanJsonLike(raw) {
  return raw
    .replace(/\bNaN\b/g, "null")
    .replace(/\bInfinity\b/g, "null")
    .replace(/\b-Infinity\b/g, "null");
}

function getFlightAttributeSchema() {
  try {
    const raw = fs.readFileSync(FLIGHT_ATTRIBUTES_SCHEMA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const attributes = Array.isArray(parsed.attributes) ? parsed.attributes : [];
    return {
      schemaVersion: parsed.schemaVersion || 1,
      attributes,
    };
  } catch (_error) {
    return {
      schemaVersion: 1,
      attributes: [],
    };
  }
}

let cachedFileInterfaces = null;
function loadFileInterfaces() {
  if (cachedFileInterfaces) return cachedFileInterfaces;
  const modules = fs
    .readdirSync(FILE_INTERFACES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".interface.js"))
    .map((entry) => require(path.join(FILE_INTERFACES_DIR, entry.name)))
    .filter((definition) => definition && typeof definition.supports === "function" && typeof definition.parseSummary === "function")
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  cachedFileInterfaces = modules;
  return modules;
}

function parseWithFileInterface(fileInput, mode, api) {
  const interfaces = loadFileInterfaces();
  for (const definition of interfaces) {
    if (!definition.supports(fileInput)) continue;
    if (mode === "viewer" && typeof definition.parseViewer === "function") {
      return definition.parseViewer(fileInput, api);
    }
    return definition.parseSummary(fileInput, api);
  }
  throw new Error("No matching file interface found.");
}

function defaultOverrides() {
  return {
    schemaVersion: 2,
    flight: {
      notes: "",
      tags: [],
      attributes: {},
    },
    altimeters: {},
  };
}

function loadFlightUserOverrides(flightPath) {
  const overridesPath = path.join(flightPath, USER_OVERRIDES_FILENAME);
  if (!fs.existsSync(overridesPath)) return defaultOverrides();
  try {
    const raw = fs.readFileSync(overridesPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultOverrides(),
      ...parsed,
      flight: {
        ...defaultOverrides().flight,
        ...(parsed.flight || {}),
      },
      altimeters: parsed.altimeters && typeof parsed.altimeters === "object" ? parsed.altimeters : {},
    };
  } catch (_error) {
    return defaultOverrides();
  }
}

// User overrides are the durable user-authored layer. Keep this merge behavior stable:
// future parser/index changes may add computed fields, but they must not destroy user edits.
function saveFlightUserOverrides(flightPath, patch) {
  const current = loadFlightUserOverrides(flightPath);
  const next = {
    ...current,
    ...patch,
    flight: {
      ...current.flight,
      ...(patch.flight || {}),
      tags: Array.isArray(patch.flight?.tags) ? patch.flight.tags : current.flight.tags,
      attributes:
        patch.flight?.attributes && typeof patch.flight.attributes === "object"
          ? {
              ...(current.flight.attributes || {}),
              ...patch.flight.attributes,
            }
          : current.flight.attributes || {},
    },
    altimeters: {
      ...current.altimeters,
    },
  };

  if (patch.altimeters && typeof patch.altimeters === "object") {
    for (const [altimeterId, overridePatch] of Object.entries(patch.altimeters)) {
      const currentAltimeter = current.altimeters[altimeterId] || {};
      next.altimeters[altimeterId] = {
        ...currentAltimeter,
        ...overridePatch,
        tags: Array.isArray(overridePatch.tags) ? overridePatch.tags : currentAltimeter.tags || [],
        hiddenAttributeKeys: Array.isArray(overridePatch.hiddenAttributeKeys)
          ? overridePatch.hiddenAttributeKeys
          : Array.isArray(currentAltimeter.hiddenAttributeKeys)
            ? currentAltimeter.hiddenAttributeKeys
            : [],
        attributeOverrides:
          overridePatch.attributeOverrides && typeof overridePatch.attributeOverrides === "object"
            ? {
                ...(currentAltimeter.attributeOverrides || {}),
                ...overridePatch.attributeOverrides,
              }
            : currentAltimeter.attributeOverrides || {},
        files: {
          ...(currentAltimeter.files || {}),
          ...(overridePatch.files || {}),
        },
      };
    }
  }

  const overridesPath = path.join(flightPath, USER_OVERRIDES_FILENAME);
  fs.writeFileSync(overridesPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function relativeDisplayPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function cleanAttributeKey(rawKey) {
  return String(rawKey || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAttributeValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  return JSON.stringify(value);
}

function flattenMetadataAttributes(metadata, prefix) {
  const out = {};
  if (!metadata || typeof metadata !== "object") return out;

  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const keyPart = cleanAttributeKey(rawKey);
    if (!keyPart) continue;
    const key = `${prefix}.${keyPart}`;
    out[key] = normalizeAttributeValue(rawValue);
  }
  return out;
}

function resolveAltimeterInterface(files) {
  for (const definition of ALTIMETER_INTERFACES) {
    if (definition.supports(files)) return definition;
  }
  return { id: "unknown", label: "Unknown" };
}

function listFlightDataFiles(flightPath) {
  const files = [];

  function visit(currentPath, relativeDir) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (GENERATED_FILENAMES.has(entry.name)) continue;
      files.push({
        fileName: entry.name,
        fullPath,
        relativePath,
        relativeDisplayPath: relativeDisplayPath(relativePath),
        topLevelFolder: relativePath.includes(path.sep) ? relativePath.split(path.sep)[0] : null,
      });
    }
  }

  visit(flightPath, "");
  return files;
}

function getDirectorySignature(flightPath) {
  const files = listFlightDataFiles(flightPath)
    .map((file) => {
      const stat = fs.statSync(file.fullPath);
      return `${file.relativeDisplayPath}|${stat.size}|${stat.mtimeMs}`;
    })
    .sort()
    .join("\n");

  const overridesPath = path.join(flightPath, USER_OVERRIDES_FILENAME);
  const overridesSignature = fs.existsSync(overridesPath)
    ? (() => {
        const stat = fs.statSync(overridesPath);
        return `${USER_OVERRIDES_FILENAME}|${stat.size}|${stat.mtimeMs}`;
      })()
    : "";

  return crypto.createHash("sha1").update(`${files}\n${overridesSignature}`).digest("hex");
}

function parseDelimitedTable(content, preferredDelimiter) {
  const firstLine = content.split(/\r?\n/, 1)[0] || "";
  const candidates = preferredDelimiter ? [preferredDelimiter] : [",", "\t", ";"];
  if (!preferredDelimiter && firstLine.includes("\t")) candidates.unshift("\t");

  for (const delimiter of candidates) {
    try {
      const rows = parseCsv(content, {
        columns: (headers) => headers.map(normalizeHeader),
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
        bom: true,
        delimiter,
      });
      if (!Array.isArray(rows) || rows.length === 0) continue;
      return {
        ok: true,
        rows,
        columns: Object.keys(rows[0]),
        delimiter,
      };
    } catch (_error) {
      // try next delimiter
    }
  }

  return { ok: false, rows: [], columns: [], delimiter: null };
}

function parsePerfectfliteText(content) {
  if (!content.includes("PerfectFlite SLCF")) return null;
  const lines = content.split(/\r?\n/);
  const metadata = {};
  const dataRows = [];
  let inData = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("Data:")) {
      inData = true;
      continue;
    }
    if (!inData) {
      const idx = line.indexOf(":");
      if (idx > -1) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        metadata[key] = value;
      }
      continue;
    }
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length < 5) continue;
    dataRows.push({
      time_s: parts[0],
      altitude_ft: parts[1],
      velocity_ft_s: parts[2],
      temperature_f: parts[3],
      voltage_v: parts[4],
    });
  }
  return {
    kind: dataRows.length ? "tabular" : "metadata",
    format: "perfectflite-text",
    metadata,
    rows: dataRows,
    columns: dataRows.length ? Object.keys(dataRows[0]) : [],
  };
}

function looksLikeGpsTrack(content) {
  const lines = splitLines(content).slice(0, 20);
  if (lines.length < 2) return false;
  let matches = 0;
  for (const line of lines) {
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length !== 4) continue;
    const parsed = parts.map((value) => safeNumber(value));
    if (parsed.every((value) => value !== null)) matches += 1;
  }
  return matches >= Math.min(lines.length, 5);
}

function parseGpsTrack(content) {
  const rows = [];
  for (const line of splitLines(content)) {
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length !== 4) continue;
    rows.push({
      unix_time_s: parts[0],
      lat: parts[1],
      lon: parts[2],
      altitude_m: parts[3],
    });
  }
  return {
    kind: "tabular",
    format: "gps-track-text",
    metadata: {},
    rows,
    columns: rows.length ? Object.keys(rows[0]) : [],
  };
}

function parseJsonMetadata(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(cleanJsonLike(raw));
  return {
    kind: "metadata",
    format: "metadata-json",
    metadata: parsed && typeof parsed === "object" ? parsed : {},
    rows: [],
    columns: [],
  };
}

function parseTabularFile(filePath, ext) {
  const content = fs.readFileSync(filePath, "utf8");
  const perfectflite = parsePerfectfliteText(content);
  if (perfectflite) return perfectflite;
  if (looksLikeGpsTrack(content)) return parseGpsTrack(content);

  const preferredDelimiter = ext === ".txt" ? "\t" : undefined;
  const parsed = parseDelimitedTable(content, preferredDelimiter);
  if (!parsed.ok) {
    return {
      kind: "unsupported",
      format: "unparsed-text",
      metadata: {},
      rows: [],
      columns: [],
    };
  }
  return {
    kind: "tabular",
    format: parsed.delimiter === "\t" ? "tabular-tsv" : "tabular-csv",
    metadata: {},
    rows: parsed.rows,
    columns: parsed.columns,
  };
}

function getDescriptorTags(baseNameNoExt) {
  const tags = [];
  const normalized = baseNameNoExt.toLowerCase();
  for (const word of ["primary", "backup", "ridealong", "doctored", "pre reboot", "post reboot"]) {
    if (normalized.includes(word)) tags.push(word);
  }
  const boardMatch = normalized.match(/\bboard\d+\b/g);
  if (boardMatch) tags.push(...boardMatch);
  return Array.from(new Set(tags));
}

function detectDeviceType(fileName, ext) {
  const lower = fileName.toLowerCase();
  if (lower.includes("line cutter") || lower.includes("linecutter")) return "linecutter";
  if (ext === ".json") return "metadata";
  if (ext === ".eeprom") return "easymini-eeprom";
  if (lower.includes("easymini") || lower.includes("ez mini") || lower.includes("serial-")) return "easymini";
  if (lower.includes("perfectflite") || lower.includes("strat")) return "perfectflite";
  if (lower.includes("gps") || lower.includes("eggfinder")) return "gps";
  if (lower.includes("groundstation")) return "groundstation";
  if (lower.includes("config commands") || lower.includes("parsed_messages") || lower.includes("calibration")) return "support";
  if (lower.includes("output-fcb") || lower.includes("output-post") || lower.match(/\bv\d+\b/)) return "sillygoose";
  return "unknown";
}

function convertTimeValueToSeconds(rawValue, column) {
  const numeric = safeNumber(rawValue);
  if (numeric === null) return null;
  const name = String(column || "").toLowerCase();
  if (name === "timestampms" || name === "timestamp_ms") return numeric / 1000;
  if (name === "unix_time_s") return numeric;
  if (name.includes("timestamp") && Math.abs(numeric) > 1e12) return numeric / 1000;
  return numeric;
}

function buildTimeSeries(rows, columns) {
  const timeColumn = findFirstExistingKey(columns, TIME_KEYS);
  if (!timeColumn) return null;

  const rawValues = rows.map((row) => convertTimeValueToSeconds(row[timeColumn], timeColumn));
  const valid = rawValues.filter((value) => value !== null);
  if (!valid.length) return null;

  const first = valid[0];
  const shouldNormalizeFromFirst =
    timeColumn === "timestampMs" ||
    timeColumn === "timestamp_ms" ||
    timeColumn === "unix_time_s" ||
    (timeColumn === "timestamp" && Math.abs(first) > 1000);

  const normalized = rawValues.map((value) => {
    if (value === null) return null;
    return shouldNormalizeFromFirst ? value - first : value;
  });

  const validNormalized = normalized.filter((value) => value !== null);
  return {
    sourceColumn: timeColumn,
    values: normalized,
    min: round(Math.min(...validNormalized), 5),
    max: round(Math.max(...validNormalized), 5),
  };
}

function hasUsefulVariation(values, epsilon) {
  const filtered = values.filter((value) => value !== null);
  if (filtered.length < 5) return false;
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  return max - min > epsilon;
}

function buildPath3d(rows, columns, maxPoints = 4000) {
  const latKey = findFirstExistingKey(columns, LAT_KEYS);
  const lonKey = findFirstExistingKey(columns, LON_KEYS);
  const altitudeKey = findFirstExistingKey(columns, ALTITUDE_KEYS);
  const posXKey = columns.includes("pos_x") ? "pos_x" : null;
  const posYKey = columns.includes("pos_y") ? "pos_y" : null;
  const posZKey = columns.includes("pos_z") ? "pos_z" : null;

  const step = Math.max(1, Math.ceil(rows.length / maxPoints));
  const sampledRows = [];
  for (let index = 0; index < rows.length; index += step) sampledRows.push(rows[index]);

  if (latKey && lonKey && altitudeKey) {
    const lat = [];
    const lon = [];
    const alt = [];
    for (const row of sampledRows) {
      const latValue = safeNumber(row[latKey]);
      const lonValue = safeNumber(row[lonKey]);
      const altValue = safeNumber(row[altitudeKey]);
      if (latValue === null || lonValue === null || altValue === null) continue;
      lat.push(round(latValue, 7));
      lon.push(round(lonValue, 7));
      alt.push(round(altValue, 3));
    }
    if (lat.length > 4 && (hasUsefulVariation(lat, 0.00001) || hasUsefulVariation(lon, 0.00001) || hasUsefulVariation(alt, 0.5))) {
      return {
        mode: "geo",
        x: lon,
        y: lat,
        z: alt,
      };
    }
  }

  if (posXKey && posYKey && posZKey) {
    const x = [];
    const y = [];
    const z = [];
    for (const row of sampledRows) {
      const xv = safeNumber(row[posXKey]);
      const yv = safeNumber(row[posYKey]);
      const zv = safeNumber(row[posZKey]);
      if (xv === null || yv === null || zv === null) continue;
      x.push(round(xv, 3));
      y.push(round(yv, 3));
      z.push(round(zv, 3));
    }
    if (x.length > 4 && (hasUsefulVariation(x, 0.5) || hasUsefulVariation(y, 0.5) || hasUsefulVariation(z, 0.5))) {
      return {
        mode: "cartesian",
        x,
        y,
        z,
      };
    }
  }

  return null;
}

function addEvent(map, label, timeSeconds, source, fileRelativePath) {
  if (!label) return;
  const key = `${label}|${timeSeconds === null ? "none" : round(timeSeconds, 3)}|${fileRelativePath}`;
  if (!map.has(key)) {
    map.set(key, {
      label,
      timeSeconds: timeSeconds === null ? null : round(timeSeconds, 3),
      source,
      fileRelativePath,
    });
  }
}

function parseMetadataEventTime(value) {
  const match = String(value || "").match(/(-?\d+(?:\.\d+)?)\s*seconds?/i);
  if (!match) return null;
  return safeNumber(match[1]);
}

function extractEventsFromRows(rows, columns, fileRelativePath) {
  const timeSeries = buildTimeSeries(rows, columns);
  if (!timeSeries) return [];

  const events = new Map();
  const stateKey = columns.find((name) => ["state_name", "stateName"].includes(name));
  if (stateKey) {
    const seenStates = new Set();
    rows.forEach((row, index) => {
      const rawState = String(row[stateKey] ?? "").trim();
      if (!rawState) return;
      const normalizedState = rawState.toLowerCase();
      if (seenStates.has(normalizedState)) return;
      seenStates.add(normalizedState);
      if (["boost", "launch", "liftoff", "coast", "burnout", "apogee", "drogue", "main", "landing", "landed", "touchdown"].some((token) => normalizedState.includes(token))) {
        addEvent(events, rawState, timeSeries.values[index], "state_name", fileRelativePath);
      }
    });
  }

  const columnEvents = [
    { column: "drogueFired", label: "Drogue Deploy" },
    { column: "mainFired", label: "Main Deploy" },
  ];
  for (const eventDef of columnEvents) {
    if (!columns.includes(eventDef.column)) continue;
    const rowIndex = rows.findIndex((row) => safeNumber(row[eventDef.column]) === 1);
    if (rowIndex >= 0) {
      addEvent(events, eventDef.label, timeSeries.values[rowIndex], eventDef.column, fileRelativePath);
    }
  }

  return Array.from(events.values()).sort((a, b) => {
    if (a.timeSeconds === null) return 1;
    if (b.timeSeconds === null) return -1;
    return a.timeSeconds - b.timeSeconds;
  });
}

function extractEventsFromMetadata(metadata, fileRelativePath) {
  const events = new Map();
  const metadataEntries = Object.entries(metadata || {});

  for (const [key, value] of metadataEntries) {
    const normalized = key.toLowerCase();
    if (normalized.includes("drogue at")) {
      addEvent(events, "Drogue Deploy", parseMetadataEventTime(value), key, fileRelativePath);
    } else if (normalized.includes("main at")) {
      addEvent(events, "Main Deploy", parseMetadataEventTime(value), key, fileRelativePath);
    } else if (normalized === "apogee_timestamp") {
      const numeric = safeNumber(value);
      if (numeric !== null) addEvent(events, "Apogee", numeric / 1000, key, fileRelativePath);
    }
  }

  return Array.from(events.values()).sort((a, b) => {
    if (a.timeSeconds === null) return 1;
    if (b.timeSeconds === null) return -1;
    return a.timeSeconds - b.timeSeconds;
  });
}

function detectDefaultSeries(columns) {
  const defaults = [];
  const altitude = findFirstExistingKey(columns, ALTITUDE_KEYS);
  const speed = findFirstExistingKey(columns, SPEED_KEYS);
  const acceleration = findFirstExistingKey(columns, ACCELERATION_KEYS);
  for (const column of [altitude, speed, acceleration]) {
    if (column && !defaults.includes(column)) defaults.push(column);
  }
  return defaults;
}

function buildTabularStats(rows, columns, metadata, fileRelativePath) {
  const numericColumns = [];
  const columnStats = {};
  const scanRows = rows.slice(0, Math.min(rows.length, 12000));

  for (const column of columns) {
    let numericCount = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const row of scanRows) {
      const value = safeNumber(row[column]);
      if (value === null) continue;
      numericCount += 1;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (numericCount >= Math.max(5, Math.floor(scanRows.length * 0.25))) {
      numericColumns.push(column);
      columnStats[column] = {
        min: Number.isFinite(min) ? round(min) : null,
        max: Number.isFinite(max) ? round(max) : null,
      };
    }
  }

  const timeSeries = buildTimeSeries(rows, columns);
  const path3d = buildPath3d(rows, columns, 1800);
  const rowEvents = extractEventsFromRows(rows, columns, fileRelativePath);
  const altitudeKey = findFirstExistingKey(columns, ALTITUDE_KEYS);
  const speedKey = findFirstExistingKey(columns, SPEED_KEYS);

  return {
    rowCount: rows.length,
    numericColumns,
    columnStats,
    axisCandidates: {
      time: timeSeries ? timeSeries.sourceColumn : null,
      altitude: altitudeKey,
      speed: speedKey,
      acceleration: findFirstExistingKey(columns, ACCELERATION_KEYS),
      lat: findFirstExistingKey(columns, LAT_KEYS),
      lon: findFirstExistingKey(columns, LON_KEYS),
      posX: columns.includes("pos_x") ? "pos_x" : null,
      posY: columns.includes("pos_y") ? "pos_y" : null,
      posZ: columns.includes("pos_z") ? "pos_z" : null,
    },
    metrics: {
      maxAltitude: altitudeKey && columnStats[altitudeKey] ? columnStats[altitudeKey].max : null,
      maxSpeed: speedKey && columnStats[speedKey] ? columnStats[speedKey].max : null,
      hasUsable3dPath: Boolean(path3d),
      timeStartSeconds: timeSeries ? timeSeries.min : null,
      timeEndSeconds: timeSeries ? timeSeries.max : null,
      defaultSeries: detectDefaultSeries(columns),
    },
    path3dSummary: path3d
      ? {
          mode: path3d.mode,
          pointCount: path3d.x.length,
        }
      : null,
    events: rowEvents,
    metadata: metadata || {},
  };
}

function parseFileForSummary(fileInfo) {
  const ext = path.extname(fileInfo.fileName).toLowerCase();
  const baseNoExt = path.basename(fileInfo.fileName, ext);
  const tags = getDescriptorTags(baseNoExt);
  const fileInput = {
    ...fileInfo,
    ext,
  };

  let parsed;
  try {
    parsed = parseWithFileInterface(fileInput, "summary", {
      parseJsonMetadata,
      parseTabularFile,
    });
  } catch (error) {
    parsed = {
      kind: "error",
      format: "parse-error",
      metadata: {},
      rows: [],
      columns: [],
      error: error.message,
    };
  }

  const stat = fs.statSync(fileInfo.fullPath);
  const deviceType = detectDeviceType(fileInfo.fileName, ext);
  const tabularStats =
    parsed.kind === "tabular" ? buildTabularStats(parsed.rows, parsed.columns, parsed.metadata, fileInfo.relativeDisplayPath) : null;
  const metadataEvents = extractEventsFromMetadata(parsed.metadata || {}, fileInfo.relativeDisplayPath);

  const stats = tabularStats || {
    rowCount: 0,
    numericColumns: [],
    columnStats: {},
    axisCandidates: {},
    metrics: {
      maxAltitude: null,
      maxSpeed: null,
      hasUsable3dPath: false,
      timeStartSeconds: null,
      timeEndSeconds: null,
      defaultSeries: [],
    },
    path3dSummary: null,
    events: metadataEvents,
    metadata: parsed.metadata || {},
  };

  if (tabularStats && metadataEvents.length) {
    const merged = new Map();
    for (const event of [...tabularStats.events, ...metadataEvents]) {
      addEvent(merged, event.label, event.timeSeconds, event.source, event.fileRelativePath);
    }
    stats.events = Array.from(merged.values()).sort((a, b) => {
      if (a.timeSeconds === null) return 1;
      if (b.timeSeconds === null) return -1;
      return a.timeSeconds - b.timeSeconds;
    });
  }

  return {
    fileName: fileInfo.fileName,
    relativePath: fileInfo.relativeDisplayPath,
    ext,
    deviceType,
    format: parsed.format,
    parseKind: parsed.kind,
    tags,
    columns: parsed.columns || [],
    metadata: parsed.metadata || {},
    stats,
    parseError: parsed.error || null,
    sizeBytes: stat.size,
    modifiedMs: stat.mtimeMs,
  };
}

function tokenizeFilename(text) {
  return sanitizeSlug(text)
    .split("-")
    .filter((token) => token && !["txt", "csv", "json", "eeprom", "output", "post", "metadata", "parsed"].includes(token));
}

function deriveFileIdentity(fileSummary, flightInfo) {
  const lower = fileSummary.fileName.toLowerCase();
  const stem = normalizeStemForMatching(path.basename(fileSummary.fileName, fileSummary.ext));
  const role = fileSummary.tags.find((tag) => ["primary", "backup", "ridealong"].includes(tag)) || null;
  const board = fileSummary.tags.find((tag) => /^board\d+$/.test(tag)) || null;
  const versionMatch = lower.match(/\bv(\d+)\b/);
  const serialMatch = lower.match(/serial[-_ ]?(\d+)/);
  const lineCutterMatch = lower.match(/line cutter\s*(\d+)/i) || lower.match(/linecutter[-_ ]?(\d+)/i);

  if (fileSummary.deviceType === "sillygoose") {
    const version = versionMatch ? `v${versionMatch[1]}` : stem || "unit";
    const slug = sanitizeSlug(["sillygoose", version, role, board].filter(Boolean).join("-"));
    const label = `SillyGoose ${version.toUpperCase()}${role ? ` ${role}` : ""}${board ? ` ${board}` : ""}`.trim();
    return { folderName: slug, displayName: label, stem, priority: 30 };
  }

  if (fileSummary.deviceType === "easymini" || fileSummary.deviceType === "easymini-eeprom") {
    const serial = serialMatch ? serialMatch[1] : null;
    const slug = sanitizeSlug(["easymini", role, serial ? `serial-${serial}` : stem].filter(Boolean).join("-"));
    const label = `EasyMini${serial ? ` #${serial}` : ""}${role ? ` ${role}` : ""}`.trim();
    return { folderName: slug, displayName: label, stem, priority: 28 };
  }

  if (fileSummary.deviceType === "perfectflite") {
    const slug = sanitizeSlug(["perfectflite", role, stem].filter(Boolean).join("-"));
    const label = `PerfectFlite${role ? ` ${role}` : ""}`.trim();
    return { folderName: slug, displayName: label, stem, priority: 24 };
  }

  if (fileSummary.deviceType === "linecutter") {
    const id = lineCutterMatch ? lineCutterMatch[1] : stem;
    const slug = sanitizeSlug(`linecutter-${id}`);
    return { folderName: slug, displayName: `Line Cutter ${id}`, stem, priority: 22 };
  }

  if (fileSummary.deviceType === "gps") {
    return { folderName: sanitizeSlug(["gps", stem].filter(Boolean).join("-")), displayName: "GPS", stem, priority: 12 };
  }

  if (fileSummary.deviceType === "groundstation") {
    return { folderName: sanitizeSlug(["groundstation", stem].filter(Boolean).join("-")), displayName: "Ground Station", stem, priority: 5 };
  }

  if (fileSummary.deviceType === "metadata" || fileSummary.deviceType === "support") {
    return { folderName: sanitizeSlug(stem || `${flightInfo.rocketName}-support`), displayName: titleCaseFromSlug(stem), stem, priority: 3 };
  }

  return {
    folderName: sanitizeSlug(stem || fileSummary.fileName),
    displayName: titleCaseFromSlug(stem || fileSummary.fileName),
    stem,
    priority: 1,
  };
}

function computeTokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  let matches = 0;
  for (const token of tokensA) {
    if (setB.has(token)) matches += 1;
  }
  return matches;
}

function groupRootFilesIntoAltimeters(fileSummaries, flightInfo) {
  const rootFiles = fileSummaries.filter((file) => !file.relativePath.includes("/"));
  const nestedFiles = fileSummaries.filter((file) => file.relativePath.includes("/"));
  const groups = new Map();

  for (const file of nestedFiles) {
    const folderName = file.relativePath.split("/")[0];
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName).push(file);
  }

  const rootCandidates = rootFiles.map((file) => ({
    file,
    identity: deriveFileIdentity(file, flightInfo),
  }));

  for (const candidate of rootCandidates) {
    const folderName = candidate.identity.folderName;
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName).push(candidate.file);
  }

  // Attach loose support files to the most likely main device group.
  const folders = Array.from(groups.keys());
  for (const candidate of rootCandidates) {
    if (!["groundstation", "support", "metadata"].includes(candidate.file.deviceType)) continue;

    const currentFolder = candidate.identity.folderName;
    const currentFiles = groups.get(currentFolder) || [];
    if (currentFiles.length > 1) continue;

    const candidateTokens = tokenizeFilename(candidate.identity.stem || candidate.file.fileName);
    let bestFolder = null;
    let bestScore = -1;

    for (const folderName of folders) {
      if (folderName === currentFolder) continue;
      const groupFiles = groups.get(folderName) || [];
      const hasMainData = groupFiles.some((file) => ["sillygoose", "easymini", "perfectflite", "linecutter"].includes(file.deviceType));
      if (!hasMainData) continue;
      const firstFile = groupFiles[0];
      const overlap = computeTokenOverlap(candidateTokens, tokenizeFilename(firstFile.fileName));
      const boost = groupFiles.some((file) => file.deviceType === "sillygoose") ? 2 : 0;
      const score = overlap + boost;
      if (score > bestScore) {
        bestScore = score;
        bestFolder = folderName;
      }
    }

    if (!bestFolder) {
      const mainFolders = folders.filter((folderName) =>
        (groups.get(folderName) || []).some((file) => ["sillygoose", "easymini", "perfectflite", "linecutter"].includes(file.deviceType))
      );
      if (mainFolders.length === 1) bestFolder = mainFolders[0];
    }

    if (bestFolder && bestFolder !== currentFolder) {
      groups.set(currentFolder, currentFiles.filter((file) => file.relativePath !== candidate.file.relativePath));
      groups.get(bestFolder).push(candidate.file);
    }
  }

  return Array.from(groups.entries())
    .filter(([, files]) => files.length > 0)
    .map(([folderName, files]) => ({
      folderName,
      files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    }))
    .sort((a, b) => a.folderName.localeCompare(b.folderName));
}

function timeseriesFamily(file) {
  if (file.deviceType === "gps") return "gps";
  if (file.deviceType === "groundstation") return "groundstation";
  if (file.deviceType === "linecutter") return "linecutter";
  if (file.deviceType === "perfectflite") return "perfectflite";
  if (file.deviceType === "easymini" || file.deviceType === "easymini-eeprom") return "easymini";
  if (file.deviceType === "sillygoose") return "sillygoose";
  return file.deviceType || "unknown";
}

function splitGroupsByTimeseries(groups) {
  const exploded = [];
  for (const group of groups) {
    const tabularFiles = group.files.filter((file) => file.parseKind === "tabular");
    if (tabularFiles.length <= 1) {
      exploded.push(group);
      continue;
    }

    const byFamily = new Map();
    for (const file of tabularFiles) {
      const family = timeseriesFamily(file);
      if (!byFamily.has(family)) byFamily.set(family, []);
      byFamily.get(family).push(file);
    }

    if (byFamily.size <= 1) {
      exploded.push(group);
      continue;
    }

    for (const [family, files] of byFamily.entries()) {
      exploded.push({
        folderName: `${group.folderName}-${family}`,
        files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      });
    }
  }
  return exploded;
}

function choosePrimaryDataFile(files, overridePreferredPath) {
  if (overridePreferredPath) {
    const preferred = files.find((file) => file.relativePath === overridePreferredPath && file.parseKind === "tabular");
    if (preferred) return preferred.relativePath;
  }

  const scored = files
    .filter((file) => file.parseKind === "tabular")
    .map((file) => {
      let score = 0;
      if (["sillygoose", "easymini", "perfectflite", "linecutter"].includes(file.deviceType)) score += 50;
      if (file.deviceType === "groundstation") score += 30;
      if (file.deviceType === "gps") score += 20;
      if (file.stats.axisCandidates.time) score += 20;
      if (file.stats.axisCandidates.altitude) score += 15;
      if (file.stats.axisCandidates.speed) score += 10;
      if (file.stats.metrics.hasUsable3dPath) score += 8;
      if (file.fileName.toLowerCase().includes("output-fcb-post")) score += 10;
      if (file.fileName.toLowerCase().includes("output-post")) score += 8;
      if (file.fileName.toLowerCase().includes("clip")) score -= 10;
      return { file, score };
    })
    .sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));

  return scored[0] ? scored[0].file.relativePath : null;
}

function mergeEvents(files) {
  const events = new Map();
  for (const file of files) {
    for (const event of file.stats.events || []) {
      addEvent(events, event.label, event.timeSeconds, event.source, event.fileRelativePath);
    }
  }
  return Array.from(events.values()).sort((a, b) => {
    if (a.timeSeconds === null) return 1;
    if (b.timeSeconds === null) return -1;
    return a.timeSeconds - b.timeSeconds;
  });
}

function buildBaseUnifiedAttributes(flightDirectory, altimeterId, interfaceDef, primaryFile, allFiles) {
  const attributes = {
    "altimeter.id": altimeterId,
    "altimeter.interface": interfaceDef.id,
    "altimeter.device_types": Array.from(new Set(allFiles.map((file) => file.deviceType))).sort().join(", "),
    "flight.date": flightDirectory.info.date || "",
    "flight.rocket_name": flightDirectory.info.rocketName || "",
  };

  if (primaryFile) {
    attributes["data.file_name"] = primaryFile.fileName || "";
    attributes["data.relative_path"] = primaryFile.relativePath || "";
    attributes["data.format"] = primaryFile.format || "";
    attributes["data.row_count"] = primaryFile.stats.rowCount || 0;
    attributes["data.time_column"] = primaryFile.stats.axisCandidates.time || "";
    attributes["data.time_start_s"] = primaryFile.stats.metrics.timeStartSeconds ?? "";
    attributes["data.time_end_s"] = primaryFile.stats.metrics.timeEndSeconds ?? "";
    attributes["data.max_altitude"] = primaryFile.stats.metrics.maxAltitude ?? "";
    attributes["data.max_speed"] = primaryFile.stats.metrics.maxSpeed ?? "";
    attributes["data.has_3d_path"] = Boolean(primaryFile.stats.metrics.hasUsable3dPath);
  }

  for (const file of allFiles) {
    if (!file.metadata || typeof file.metadata !== "object" || !Object.keys(file.metadata).length) continue;
    const stem = cleanAttributeKey(path.basename(file.fileName, file.ext)) || "metadata";
    const sourcePrefix = `meta.${stem}`;
    Object.assign(attributes, flattenMetadataAttributes(file.metadata, sourcePrefix));
  }

  for (const event of mergeEvents(allFiles)) {
    if (event.timeSeconds === null || event.timeSeconds === undefined) continue;
    const key = cleanAttributeKey(`event.${event.label}.s`);
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(attributes, key)) attributes[key] = event.timeSeconds;
  }

  // Keep stable order for UI.
  const ordered = {};
  for (const key of Object.keys(attributes).sort((a, b) => a.localeCompare(b))) {
    ordered[key] = attributes[key];
  }
  return ordered;
}

function applyAttributeOverrides(baseAttributes, override) {
  const attributes = { ...baseAttributes };
  const hiddenKeys = new Set(Array.isArray(override.hiddenAttributeKeys) ? override.hiddenAttributeKeys : []);
  for (const [key, value] of Object.entries(override.attributeOverrides || {})) {
    const cleaned = cleanAttributeKey(key);
    if (!cleaned) continue;
    attributes[cleaned] = normalizeAttributeValue(value);
    hiddenKeys.delete(cleaned);
  }
  for (const key of hiddenKeys) {
    delete attributes[key];
  }

  const ordered = {};
  for (const key of Object.keys(attributes).sort((a, b) => a.localeCompare(b))) {
    ordered[key] = attributes[key];
  }
  return ordered;
}

function buildTrimWindow(events, primaryFile) {
  if (!primaryFile) return null;
  const fileStart = primaryFile.stats.metrics.timeStartSeconds;
  const fileEnd = primaryFile.stats.metrics.timeEndSeconds;
  if (fileStart === null || fileEnd === null) return null;

  const launchEvent = events.find((event) => event.timeSeconds !== null && /launch|liftoff|boost/i.test(event.label));
  const landingEvent = events.find((event) => event.timeSeconds !== null && /landing|landed|touchdown/i.test(event.label));
  if (!launchEvent || !landingEvent || landingEvent.timeSeconds <= launchEvent.timeSeconds) return null;

  return {
    startSeconds: round(Math.max(fileStart, launchEvent.timeSeconds - 2), 3),
    endSeconds: round(Math.min(fileEnd, landingEvent.timeSeconds + 2), 3),
  };
}

function buildAltimeterDisplayName(group, override) {
  if (override?.displayName) return override.displayName;
  const mainFile = group.files.find((file) => ["sillygoose", "easymini", "perfectflite", "linecutter", "gps"].includes(file.deviceType)) || group.files[0];
  if (!mainFile) return titleCaseFromSlug(group.folderName);
  return deriveFileIdentity(mainFile, { rocketName: "" }).displayName || titleCaseFromSlug(group.folderName);
}

function buildAltimeterGroup(group, flightDirectory, overrides) {
  const override = overrides.altimeters[group.folderName] || {};
  const files = group.files.slice();
  const primaryDataFile = choosePrimaryDataFile(files, override.preferredDataFile || null);
  const primaryFile = files.find((file) => file.relativePath === primaryDataFile) || null;
  if (!primaryFile) return null;

  const interfaceDef = resolveAltimeterInterface(files);
  const events = mergeEvents(files);
  const trimWindow = buildTrimWindow(events, primaryFile);
  const baseAttributes = buildBaseUnifiedAttributes(flightDirectory, group.folderName, interfaceDef, primaryFile, files);

  const maxAltitude = files
    .map((file) => file.stats.metrics.maxAltitude)
    .filter((value) => typeof value === "number")
    .reduce((acc, value) => Math.max(acc, value), -Infinity);
  const maxSpeed = files
    .map((file) => file.stats.metrics.maxSpeed)
    .filter((value) => typeof value === "number")
    .reduce((acc, value) => Math.max(acc, value), -Infinity);

  const deviceTypes = Array.from(new Set(files.map((file) => file.deviceType))).sort();
  const formats = Array.from(new Set(files.map((file) => file.format))).sort();
  const tags = Array.from(new Set([...files.flatMap((file) => file.tags), ...(override.tags || [])])).sort();

  return {
    id: group.folderName,
    folderName: group.folderName,
    folderPath: group.folderName,
    displayName: buildAltimeterDisplayName(group, override),
    interface: {
      id: interfaceDef.id,
      label: interfaceDef.label,
    },
    notes: override.notes || "",
    tags,
    deviceTypes,
    formats,
    dataFile: {
      relativePath: primaryFile.relativePath,
      fileName: primaryFile.fileName,
      format: primaryFile.format,
      deviceType: primaryFile.deviceType,
      parseKind: primaryFile.parseKind,
      rowCount: primaryFile.stats?.rowCount || 0,
      timeColumn: primaryFile.stats?.axisCandidates?.time || null,
    },
    trimWindow,
    events,
    baseAttributes,
    attributes: applyAttributeOverrides(baseAttributes, override),
    overrides: {
      displayName: override.displayName || "",
      notes: override.notes || "",
      tags: override.tags || [],
      preferredDataFile: override.preferredDataFile || "",
      hiddenAttributeKeys: override.hiddenAttributeKeys || [],
      attributeOverrides: override.attributeOverrides || {},
      files: override.files || {},
    },
    stats: {
      maxAltitude: Number.isFinite(maxAltitude) ? round(maxAltitude) : null,
      maxSpeed: Number.isFinite(maxSpeed) ? round(maxSpeed) : null,
      hasUsable3dPath: files.some((file) => file.stats.metrics.hasUsable3dPath),
    },
  };
}

function buildFlightOverview(flightDirectory) {
  const fileInfos = listFlightDataFiles(flightDirectory.path);
  const fileSummaries = fileInfos.map(parseFileForSummary);
  const overrides = loadFlightUserOverrides(flightDirectory.path);
  const grouped = splitGroupsByTimeseries(groupRootFilesIntoAltimeters(fileSummaries, flightDirectory.info));
  const altimeters = grouped.map((group) => buildAltimeterGroup(group, flightDirectory, overrides)).filter(Boolean);

  const maxAltitude = altimeters
    .map((altimeter) => altimeter.stats.maxAltitude)
    .filter((value) => typeof value === "number")
    .reduce((acc, value) => Math.max(acc, value), -Infinity);
  const maxSpeed = altimeters
    .map((altimeter) => altimeter.stats.maxSpeed)
    .filter((value) => typeof value === "number")
    .reduce((acc, value) => Math.max(acc, value), -Infinity);

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    indexerVersion: INDEXER_VERSION,
    directory: flightDirectory.name,
    date: flightDirectory.info.date,
    year: flightDirectory.info.year,
    rocketName: flightDirectory.info.rocketName,
    stats: {
      totalFiles: fileSummaries.length,
      altimeterCount: altimeters.length,
      parsedDataFiles: fileSummaries.filter((file) => file.parseKind === "tabular").length,
      maxAltitude: Number.isFinite(maxAltitude) ? round(maxAltitude) : null,
      maxSpeed: Number.isFinite(maxSpeed) ? round(maxSpeed) : null,
      hasUsable3dPath: altimeters.some((altimeter) => altimeter.stats.hasUsable3dPath),
    },
    filters: {
      formats: Array.from(new Set(altimeters.flatMap((altimeter) => altimeter.formats))).sort(),
      deviceTypes: Array.from(new Set(altimeters.flatMap((altimeter) => altimeter.deviceTypes))).sort(),
      interfaces: Array.from(new Set(altimeters.map((altimeter) => altimeter.interface.id))).sort(),
      tags: Array.from(new Set([...altimeters.flatMap((altimeter) => altimeter.tags), ...(overrides.flight.tags || [])])).sort(),
    },
    altimeters,
  };
}

function writeFlightOverview(flightDirectory, overview) {
  fs.writeFileSync(path.join(flightDirectory.path, OVERVIEW_FILENAME), JSON.stringify(overview, null, 2), "utf8");
}

function readAllOverviews(dataRoot) {
  const overviews = [];
  for (const flight of listFlightDirectories(dataRoot)) {
    const overviewPath = path.join(flight.path, OVERVIEW_FILENAME);
    if (!fs.existsSync(overviewPath)) continue;
    try {
      overviews.push(JSON.parse(fs.readFileSync(overviewPath, "utf8")));
    } catch (_error) {
      // ignore corrupt overviews
    }
  }
  return overviews.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function buildChartSeries(rows, columns, maxPoints = 5000) {
  const stats = buildTabularStats(rows, columns, {}, "");
  const timeSeries = buildTimeSeries(rows, columns);
  if (!timeSeries) {
    return {
      rowCount: rows.length,
      sampledRowCount: 0,
      sampleStep: 1,
      numericColumns: stats.numericColumns,
      timeColumn: null,
      defaultSeries: stats.metrics.defaultSeries,
      seriesByColumn: {},
      path3d: buildPath3d(rows, columns),
    };
  }

  const step = Math.max(1, Math.ceil(rows.length / maxPoints));
  const seriesByColumn = {};
  const sampledIndices = [];
  for (let index = 0; index < rows.length; index += step) sampledIndices.push(index);

  for (const column of stats.numericColumns.slice(0, 32)) {
    const timeSeconds = [];
    const values = [];
    for (const index of sampledIndices) {
      const timeValue = timeSeries.values[index];
      const yValue = safeNumber(rows[index][column]);
      if (timeValue === null || yValue === null) continue;
      timeSeconds.push(round(timeValue, 5));
      values.push(round(yValue, 5));
    }
    if (timeSeconds.length) {
      seriesByColumn[column] = {
        timeSeconds,
        values,
      };
    }
  }

  return {
    rowCount: rows.length,
    sampledRowCount: sampledIndices.length,
    sampleStep: step,
    numericColumns: stats.numericColumns,
    timeColumn: timeSeries.sourceColumn,
    timeRange: {
      startSeconds: timeSeries.min,
      endSeconds: timeSeries.max,
    },
    defaultSeries: stats.metrics.defaultSeries,
    seriesByColumn,
    path3d: buildPath3d(rows, columns, maxPoints),
  };
}

function parseFileForViewer(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const parsed = parseWithFileInterface(
    {
      fullPath: filePath,
      fileName: path.basename(filePath),
      ext,
      relativePath: path.basename(filePath),
      relativeDisplayPath: path.basename(filePath),
    },
    "viewer",
    {
      parseJsonMetadata,
      parseTabularFile,
    }
  );
  if (parsed.kind !== "tabular") {
    return {
      filePath,
      format: parsed.format,
      parseKind: parsed.kind,
      metadata: parsed.metadata,
      columns: parsed.columns || [],
      previewRows: [],
      chartData: null,
    };
  }

  const timeSeries = buildTimeSeries(parsed.rows, parsed.columns);
  const previewRows = parsed.rows.slice(0, 800).map((row, index) => ({
    ...row,
    __time_s: timeSeries && timeSeries.values[index] !== null ? round(timeSeries.values[index], 5) : null,
  }));

  return {
    filePath,
    format: parsed.format,
    parseKind: parsed.kind,
    metadata: parsed.metadata,
    columns: parsed.columns,
    previewRows,
    chartData: buildChartSeries(parsed.rows, parsed.columns),
  };
}

function parseAltimeterForViewer(flightPath, altimeterId) {
  const overviewPath = path.join(flightPath, OVERVIEW_FILENAME);
  if (!fs.existsSync(overviewPath)) throw new Error("Overview file does not exist. Run indexing first.");
  const overview = JSON.parse(fs.readFileSync(overviewPath, "utf8"));
  const altimeter = (overview.altimeters || []).find((entry) => entry.id === altimeterId);
  if (!altimeter) throw new Error("Altimeter not found");
  if (!altimeter.dataFile?.relativePath) {
    return {
      altimeter,
      primaryFile: null,
      parsedFile: null,
    };
  }
  const primaryFile = altimeter.dataFile;
  const parsedFile = parseFileForViewer(path.join(flightPath, ...altimeter.dataFile.relativePath.split("/")));
  return {
    altimeter,
    primaryFile,
    parsedFile,
  };
}

function runIndexer(dataRoot) {
  const flights = listFlightDirectories(dataRoot);
  const manifest = loadManifest(dataRoot);
  const nextManifest = {
    indexerVersion: INDEXER_VERSION,
    generatedAt: new Date().toISOString(),
    flights: {},
  };

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for (const flight of flights) {
    scanned += 1;
    const signature = getDirectorySignature(flight.path);
    const previous = manifest.flights[flight.name];
    const canSkip =
      previous &&
      manifest.indexerVersion === INDEXER_VERSION &&
      previous.signature === signature &&
      fs.existsSync(path.join(flight.path, OVERVIEW_FILENAME));

    if (canSkip) {
      skipped += 1;
      nextManifest.flights[flight.name] = {
        signature,
        updatedAt: previous.updatedAt || new Date().toISOString(),
      };
      continue;
    }

    const overview = buildFlightOverview(flight);
    writeFlightOverview(flight, overview);
    updated += 1;
    nextManifest.flights[flight.name] = {
      signature,
      updatedAt: new Date().toISOString(),
    };
  }

  saveManifest(dataRoot, nextManifest);
  return { scanned, updated, skipped };
}

function rebuildFlightOverview(dataRoot, directoryName) {
  const flight = listFlightDirectories(dataRoot).find((entry) => entry.name === directoryName);
  if (!flight) throw new Error("Flight directory not found");
  const overview = buildFlightOverview(flight);
  writeFlightOverview(flight, overview);
  return overview;
}

function saveOverridesAndRebuildFlight(dataRoot, directoryName, patch) {
  const flightPath = path.join(dataRoot, directoryName);
  saveFlightUserOverrides(flightPath, patch);
  return rebuildFlightOverview(dataRoot, directoryName);
}

function planFlightReorganization(flightDirectory) {
  const fileInfos = listFlightDataFiles(flightDirectory.path).filter((file) => !file.topLevelFolder);
  const fileSummaries = fileInfos.map(parseFileForSummary);
  const grouped = groupRootFilesIntoAltimeters(fileSummaries, flightDirectory.info);

  return grouped.flatMap((group) =>
    group.files.map((file) => ({
      sourceRelativePath: file.relativePath,
      targetRelativePath: `${group.folderName}/${file.fileName}`,
      folderName: group.folderName,
    }))
  );
}

function reorganizeFlightDirectory(flightDirectory) {
  const plan = planFlightReorganization(flightDirectory);
  let moved = 0;

  for (const step of plan) {
    const sourcePath = path.join(flightDirectory.path, ...step.sourceRelativePath.split("/"));
    const targetPath = path.join(flightDirectory.path, ...step.targetRelativePath.split("/"));
    if (sourcePath === targetPath) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
    moved += 1;
  }

  return { moved, plan };
}

function reorganizeDataRoot(dataRoot) {
  const flights = listFlightDirectories(dataRoot);
  let moved = 0;
  for (const flight of flights) {
    const result = reorganizeFlightDirectory(flight);
    moved += result.moved;
  }
  return { flightCount: flights.length, moved };
}

module.exports = {
  OVERVIEW_FILENAME,
  MANIFEST_FILENAME,
  USER_OVERRIDES_FILENAME,
  INDEXER_VERSION,
  getDataRoot,
  listFlightDirectories,
  runIndexer,
  readAllOverviews,
  getFlightAttributeSchema,
  parseAltimeterForViewer,
  saveOverridesAndRebuildFlight,
  rebuildFlightOverview,
  reorganizeDataRoot,
};
