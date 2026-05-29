import { useEffect, useMemo, useRef, useState } from 'react';
import Plotly2D from 'plotly.js-basic-dist-min';
import Plotly3D from 'plotly.js-gl3d-dist-min';
import { CompareGpsMapView, type CompareGpsTrack } from './CompareGpsMapView';
import type {
  FlightSummary,
  ImportedAltimeterSummary,
  ImportedDataset,
  ImportConfig,
  StandardColumnRef
} from './importTypes';
import type { GpsMapPoint } from './GpsMapView';

type CompareViewProps = {
  config: ImportConfig | null;
  flights: FlightSummary[];
  isActive: boolean;
};

type CompareMode = 'plot2d' | 'plot3d' | 'map2d' | 'map3d';
type CompareMetric = 'altitude' | 'velocity' | 'acceleration' | 'all';

type TimeColumnDefinition = {
  names: string[];
  secondsPerUnit: number;
  relativeToFirstValue: boolean;
};

type CompareDataset = {
  id: string;
  label: string;
  flightName: string;
  altimeterName: string;
  importerId: string;
  dataset: ImportedDataset;
  xValues: number[];
  visibleRows: string[][];
  visibleXValues: number[];
  gpsPoints: GpsMapPoint[];
  color: [number, number, number, number];
};

const TIME_COLUMNS: TimeColumnDefinition[] = [
  { names: ['timestampms', 'timestamp_ms'], secondsPerUnit: 0.001, relativeToFirstValue: true },
  { names: ['timestampus', 'timestamp_us'], secondsPerUnit: 0.000001, relativeToFirstValue: true },
  { names: ['timestampns', 'timestamp_ns'], secondsPerUnit: 0.000000001, relativeToFirstValue: true },
  { names: ['timestamp', 'timestamps', 'timestamp_s'], secondsPerUnit: 1, relativeToFirstValue: true },
  { names: ['timems', 'time_ms', 'elapsedms', 'elapsed_ms'], secondsPerUnit: 0.001, relativeToFirstValue: false },
  { names: ['timeus', 'time_us', 'elapsedus', 'elapsed_us'], secondsPerUnit: 0.000001, relativeToFirstValue: false },
  { names: ['timens', 'time_ns', 'elapsedns', 'elapsed_ns'], secondsPerUnit: 0.000000001, relativeToFirstValue: false },
  { names: ['time', 'times', 'time_s', 'elapseds', 'elapsed_s', 'elapsedtime', 'elapsed_time'], secondsPerUnit: 1, relativeToFirstValue: false }
];

const COLORS: Array<[number, number, number, number]> = [
  [74, 214, 193, 245],
  [255, 166, 77, 245],
  [105, 167, 255, 245],
  [176, 124, 255, 245],
  [255, 110, 110, 245],
  [116, 198, 157, 245],
  [242, 201, 76, 245],
  [235, 130, 211, 245]
];

const METRIC_LABELS: Record<CompareMetric, string> = {
  altitude: 'Altitude / height',
  velocity: 'Velocity',
  acceleration: 'Acceleration',
  all: 'All standard metrics'
};

function parseNumber(value: string | undefined) {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : null;
}

function normalizedHeader(header: string) {
  return header.trim().toLowerCase();
}

function getColumnIndexByAliases(headers: string[], aliases: string[]) {
  const normalizedHeaders = headers.map(normalizedHeader);
  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(alias.toLowerCase());
    if (index >= 0) return index;
  }
  return null;
}

function getColumnIndex(headers: string[], name: string) {
  const index = headers.indexOf(name);
  return index >= 0 ? index : null;
}

function timeColumnStats(rows: string[][], columnIndex: number) {
  let first: number | null = null;
  let min: number | null = null;
  let max: number | null = null;
  let previous: number | null = null;
  const deltas: number[] = [];

  for (const row of rows) {
    const value = parseNumber(row[columnIndex]);
    if (value === null) continue;
    if (first === null) first = value;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
    if (previous !== null) {
      const delta = Math.abs(value - previous);
      if (delta > 0) deltas.push(delta);
    }
    previous = value;
  }

  const sortedDeltas = deltas.sort((left, right) => left - right);
  return {
    first,
    min,
    max,
    medianDelta: sortedDeltas[Math.floor(sortedDeltas.length / 2)] ?? null
  };
}

function isLikelyMillisecondTimestamp(
  header: string,
  relativeToFirstValue: boolean,
  secondsPerUnit: number,
  stats: { min: number | null; max: number | null; medianDelta: number | null }
) {
  if (!relativeToFirstValue || secondsPerUnit !== 1) return false;
  if (stats.min === null || stats.max === null || stats.medianDelta === null) return false;
  const normalized = normalizedHeader(header);
  const looksLikeSecondField =
    normalized.includes('timestamp_s') ||
    normalized === 'timestamp' ||
    normalized === 'timestamps' ||
    normalized === 'time_s' ||
    normalized === 'time';
  if (!looksLikeSecondField) return false;
  return Math.abs(stats.max - stats.min) > 10_000 && stats.medianDelta > 1 && stats.medianDelta * 0.001 <= 10;
}

function getTimeColumn(headers: string[], rows: string[][] = []) {
  const normalizedHeaders = headers.map(normalizedHeader);
  const candidates: Array<TimeColumnDefinition & { index: number; rangeSeconds: number }> = [];

  for (const definition of TIME_COLUMNS) {
    const index = normalizedHeaders.findIndex((header) => definition.names.includes(header));
    if (index < 0) continue;
    const stats = rows.length > 0 ? timeColumnStats(rows, index) : null;
    const secondsPerUnit =
      stats && isLikelyMillisecondTimestamp(headers[index] ?? '', definition.relativeToFirstValue, definition.secondsPerUnit, stats)
        ? 0.001
        : definition.secondsPerUnit;
    const rangeSeconds =
      stats && stats.min !== null && stats.max !== null ? Math.abs(stats.max - stats.min) * secondsPerUnit : 0;
    candidates.push({ ...definition, secondsPerUnit, index, rangeSeconds });
  }

  if (candidates.length === 0) return null;
  if (rows.length === 0) return candidates[0];
  return (
    candidates
      .filter((candidate) => candidate.rangeSeconds > 0.001)
      .sort((left, right) => right.rangeSeconds - left.rangeSeconds)[0] ?? candidates[0]
  );
}

function buildXAxis(dataset: ImportedDataset) {
  const timeColumn = getTimeColumn(dataset.headers, dataset.rows);
  if (!timeColumn) {
    return dataset.rows.map((_, index) => index);
  }

  const firstTimeValue =
    dataset.rows
      .map((row) => parseNumber(row[timeColumn.index]))
      .find((value) => value !== null) ?? 0;

  return dataset.rows.map((row, index) => {
    const timeValue = parseNumber(row[timeColumn.index]);
    if (timeValue === null) return index;
    const relativeValue = timeColumn.relativeToFirstValue ? timeValue - firstTimeValue : timeValue;
    return relativeValue * timeColumn.secondsPerUnit;
  });
}

function getImporterId(dataset: ImportedDataset) {
  return dataset.attributes.find((attribute) => attribute.key === 'importer_id')?.value ??
    dataset.summary.attributes.importer_id ??
    '';
}

function buildEventWindow(dataset: ImportedDataset, xValues: number[]) {
  const importerId = getImporterId(dataset);
  const isFcb = importerId === 'fcb';
  const stateIndex = isFcb
    ? getColumnIndex(dataset.headers, 'state')
    : getColumnIndex(dataset.headers, 'flightState') ?? getColumnIndex(dataset.headers, 'state');
  let launchTime: number | null = null;
  let endTime: number | null = null;

  if (stateIndex !== null) {
    for (let index = 1; index < dataset.rows.length; index += 1) {
      const previousState = Number.parseInt(dataset.rows[index - 1]?.[stateIndex] ?? '', 10);
      const currentState = Number.parseInt(dataset.rows[index]?.[stateIndex] ?? '', 10);
      if (!Number.isFinite(previousState) || !Number.isFinite(currentState) || previousState === currentState) {
        continue;
      }
      if (
        launchTime === null &&
        ((isFcb && currentState === 2) || (!isFcb && previousState === 0 && currentState !== 0) || currentState === 5)
      ) {
        launchTime = xValues[index];
      }
      if ((isFcb && currentState === 5) || (!isFcb && currentState === 3) || currentState === 8) {
        endTime = xValues[index];
      }
    }
  }

  const first = xValues[0] ?? 0;
  const last = xValues[xValues.length - 1] ?? first;
  const start = launchTime ?? first;
  const end = endTime ?? last;
  return { launchOffset: launchTime ?? 0, start, end };
}

function isValidLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

function scoreGpsColumnPair(rows: string[][], latitudeIndex: number, longitudeIndex: number) {
  let validCount = 0;
  let localLookingCount = 0;

  for (const row of rows) {
    const latitude = parseNumber(row[latitudeIndex]);
    const longitude = parseNumber(row[longitudeIndex]);
    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) continue;
    validCount += 1;
    if (Math.abs(latitude) < 5 && Math.abs(longitude) < 5) localLookingCount += 1;
  }

  return { validCount, localLookingCount };
}

function findGpsColumns(headers: string[], rows: string[][]) {
  const pairs = [
    { latitudeAliases: ['latitude'], longitudeAliases: ['longitude'] },
    { latitudeAliases: ['lat'], longitudeAliases: ['lon', 'lng'] },
    { latitudeAliases: ['gps_lat'], longitudeAliases: ['gps_long'] },
    { latitudeAliases: ['gps_lat_mod'], longitudeAliases: ['gps_long_mod'] }
  ];

  const candidates = pairs
    .map((pair, preferenceIndex) => {
      const latitudeIndex = getColumnIndexByAliases(headers, pair.latitudeAliases);
      const longitudeIndex = getColumnIndexByAliases(headers, pair.longitudeAliases);
      if (latitudeIndex === null || longitudeIndex === null) return null;
      return {
        latitudeIndex,
        longitudeIndex,
        preferenceIndex,
        ...scoreGpsColumnPair(rows, latitudeIndex, longitudeIndex)
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .filter((candidate) => candidate.validCount > 0);

  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const leftIsMostlyLocal = left.localLookingCount / left.validCount > 0.95;
    const rightIsMostlyLocal = right.localLookingCount / right.validCount > 0.95;
    if (leftIsMostlyLocal !== rightIsMostlyLocal) return leftIsMostlyLocal ? 1 : -1;
    if (left.validCount !== right.validCount) return right.validCount - left.validCount;
    return left.preferenceIndex - right.preferenceIndex;
  });

  return {
    latitudeIndex: candidates[0].latitudeIndex,
    longitudeIndex: candidates[0].longitudeIndex
  };
}

function findAltitudeIndex(headers: string[]) {
  return getColumnIndexByAliases(headers, ['altitude', 'altitude_m', 'altitudem', 'gps_alt', 'pos_z', 'height']);
}

function standardRefForMetric(config: ImportConfig | null, importerId: string, metric: Exclude<CompareMetric, 'all'>) {
  const mapping = config?.altimeters.find((altimeter) => altimeter.importerId === importerId)?.standardColumns;
  if (!mapping) return null;
  if (metric === 'altitude') return mapping.altitudeMeters ?? null;
  if (metric === 'velocity') return mapping.velocityMetersPerSecond ?? null;
  return mapping.accelerationMetersPerSecondSquared ?? null;
}

function metricUnit(metric: Exclude<CompareMetric, 'all'>) {
  if (metric === 'altitude') return 'm';
  if (metric === 'velocity') return 'm/s';
  return 'm/s²';
}

function metricTraceName(metric: Exclude<CompareMetric, 'all'>) {
  if (metric === 'altitude') return 'Altitude';
  if (metric === 'velocity') return 'Velocity';
  return 'Acceleration';
}

function colorString(color: [number, number, number, number], alphaScale = 1) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.min(1, (color[3] / 255) * alphaScale)})`;
}

function prepareDataset(
  dataset: ImportedDataset,
  altimeter: ImportedAltimeterSummary,
  config: ImportConfig | null,
  showFullData: boolean,
  color: [number, number, number, number]
): CompareDataset {
  const rawXValues = buildXAxis(dataset);
  const window = buildEventWindow(dataset, rawXValues);
  const xValues = rawXValues.map((value) => value - window.launchOffset);
  const minTime = xValues[0] ?? 0;
  const maxTime = xValues[xValues.length - 1] ?? minTime;
  const windowStart = Math.max(minTime, window.start - window.launchOffset - 20);
  const windowEnd = Math.min(maxTime, window.end - window.launchOffset + 20);
  const visibleIndexes = showFullData
    ? dataset.rows.map((_, index) => index)
    : xValues
        .map((time, index) => ({ time, index }))
        .filter(({ time }) => time >= windowStart && time <= windowEnd)
        .map(({ index }) => index);
  const visibleRows = visibleIndexes.map((index) => dataset.rows[index] ?? []);
  const visibleXValues = visibleIndexes.map((index) => xValues[index]);
  const gpsPositionColumns = findGpsColumns(dataset.headers, dataset.rows);
  const altitudeIndex = findAltitudeIndex(dataset.headers);
  const launchAltitude =
    altitudeIndex === null
      ? 0
      : visibleRows.map((row) => parseNumber(row[altitudeIndex])).find((value) => value !== null) ?? 0;
  const gpsPoints =
    gpsPositionColumns && altitudeIndex !== null
      ? visibleRows
          .map((row, index) => ({
            latitude: parseNumber(row[gpsPositionColumns.latitudeIndex]),
            longitude: parseNumber(row[gpsPositionColumns.longitudeIndex]),
            altitude: parseNumber(row[altitudeIndex]),
            time: visibleXValues[index]
          }))
          .filter(
            (point): point is { latitude: number; longitude: number; altitude: number; time: number } =>
              isValidLatitude(point.latitude) &&
              isValidLongitude(point.longitude) &&
              point.altitude !== null &&
              Number.isFinite(point.time)
          )
          .map((point) => ({
            ...point,
            height: Math.max(0, point.altitude - launchAltitude)
          }))
      : [];

  return {
    id: altimeter.altimeterDirectory,
    label: `${altimeter.flightDirectoryName} · ${altimeter.altimeterDirectoryName}`,
    flightName: altimeter.flightDirectoryName,
    altimeterName: altimeter.altimeterDirectoryName,
    importerId: getImporterId(dataset),
    dataset,
    xValues,
    visibleRows,
    visibleXValues,
    gpsPoints,
    color
  };
}

function seriesValues(entry: CompareDataset, ref: StandardColumnRef) {
  const index = entry.dataset.headers.indexOf(ref.column);
  if (index < 0) return null;
  const scale = ref.scaleToStandard ?? 1;
  return entry.visibleRows.map((row) => {
    const value = parseNumber(row[index]);
    return value === null ? Number.NaN : value * scale;
  });
}

function axisRange(values: number[]) {
  if (values.length === 0) return 0;
  return Math.max(0, Math.max(...values) - Math.min(...values));
}

export function CompareView({ config, flights, isActive }: CompareViewProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [mode, setMode] = useState<CompareMode>('plot2d');
  const [metric, setMetric] = useState<CompareMetric>('altitude');
  const [showFullData, setShowFullData] = useState(false);
  const [datasets, setDatasets] = useState<CompareDataset[]>([]);
  const [loadError, setLoadError] = useState('');
  const plotRef = useRef<HTMLDivElement | null>(null);

  const altimeters = useMemo(
    () =>
      flights.flatMap((flight) =>
        flight.altimeters.map((altimeter) => ({
          ...altimeter,
          flightDirectoryName: flight.directoryName,
          flightLocation: flight.location
        }))
      ),
    [flights]
  );

  const filteredFlights = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) return flights;
    return flights
      .map((flight) => ({
        ...flight,
        altimeters: flight.altimeters.filter((altimeter) =>
          [
            flight.directoryName,
            flight.location,
            altimeter.altimeterDirectoryName,
            altimeter.altimeterName,
            altimeter.motor
          ].some((value) => value?.toLowerCase().includes(keyword))
        )
      }))
      .filter((flight) => flight.altimeters.length > 0);
  }, [flights, searchText]);

  useEffect(() => {
    let ignore = false;
    setLoadError('');

    if (selectedIds.length === 0) {
      setDatasets([]);
      return;
    }

    Promise.all(
      selectedIds.map(async (id, index) => {
        const altimeter = altimeters.find((entry) => entry.altimeterDirectory === id);
        if (!altimeter) return null;
        const dataset = await window.appBridge.readDataset(id);
        return prepareDataset(dataset, altimeter, config, showFullData, COLORS[index % COLORS.length]);
      })
    )
      .then((entries) => {
        if (ignore) return;
        setDatasets(entries.filter((entry): entry is CompareDataset => entry !== null));
      })
      .catch((error: Error) => {
        if (!ignore) setLoadError(error.message);
      });

    return () => {
      ignore = true;
    };
  }, [altimeters, config, selectedIds, showFullData]);

  const traces2d = useMemo(() => {
    const selectedMetrics: Array<Exclude<CompareMetric, 'all'>> =
      metric === 'all' ? ['altitude', 'velocity', 'acceleration'] : [metric];

    return datasets.flatMap((entry) =>
      selectedMetrics.flatMap((selectedMetric) => {
        const ref = standardRefForMetric(config, entry.importerId, selectedMetric);
        if (!ref) return [];
        const values = seriesValues(entry, ref);
        if (!values) return [];
        return [
          {
            x: entry.visibleXValues,
            y: values,
            name:
              metric === 'all'
                ? `${entry.label} · ${metricTraceName(selectedMetric)}`
                : entry.label,
            mode: 'lines',
            type: 'scatter',
            line: { color: colorString(entry.color), width: 2 },
            hovertemplate:
              `Time: %{x:.2f} s<br>${metricTraceName(selectedMetric)}: %{y:.3f} ${metricUnit(selectedMetric)}<extra>%{fullData.name}</extra>`
          }
        ];
      })
    );
  }, [config, datasets, metric]);

  const gpsTracks = useMemo(
    (): CompareGpsTrack[] =>
      datasets
        .filter((entry) => entry.gpsPoints.length >= 2)
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          color: entry.color,
          points: entry.gpsPoints
        })),
    [datasets]
  );

  const gpsAspectRatio = useMemo(() => {
    const points = gpsTracks.flatMap((track) => track.points);
    if (points.length === 0) return { x: 1, y: 1, z: 1 };
    const lonRange = axisRange(points.map((point) => point.longitude));
    const latRange = axisRange(points.map((point) => point.latitude));
    const horizontalRange = Math.max(lonRange, latRange, 1e-9);
    return {
      x: Math.max(lonRange / horizontalRange, 1e-6),
      y: Math.max(latRange / horizontalRange, 1e-6),
      z: 1
    };
  }, [gpsTracks]);

  useEffect(() => {
    const plotElement = plotRef.current;
    if (!isActive || !plotElement || mode !== 'plot2d') return;

    Plotly2D.newPlot(
      plotElement,
      traces2d,
      {
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#e4e7eb' },
        margin: { t: 24, r: 24, b: 48, l: 64 },
        hovermode: 'x unified',
        xaxis: { title: 'Time since launch (s)', gridcolor: '#30343a' },
        yaxis: { title: metric === 'all' ? 'Standard value' : `${METRIC_LABELS[metric]} (${metricUnit(metric)})`, gridcolor: '#30343a' },
        legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1 }
      },
      { responsive: true, displaylogo: false, scrollZoom: true }
    ).then(() => Plotly2D.Plots.resize(plotElement));

    return () => {
      Plotly2D.purge(plotElement);
    };
  }, [isActive, metric, mode, traces2d]);

  useEffect(() => {
    const plotElement = plotRef.current;
    if (!isActive || !plotElement || mode !== 'plot3d') return;

    Plotly3D.newPlot(
      plotElement,
      gpsTracks.map((track) => ({
        type: 'scatter3d',
        mode: 'lines',
        x: track.points.map((point) => point.longitude),
        y: track.points.map((point) => point.latitude),
        z: track.points.map((point) => point.height),
        text: track.points.map((point) => `t=${point.time.toFixed(2)}s`),
        name: track.label,
        hovertemplate: 'Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Height: %{z:.2f} m<br>%{text}<extra>%{fullData.name}</extra>',
        line: { width: 4, color: colorString(track.color) }
      })),
      {
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#e4e7eb' },
        margin: { t: 24, r: 24, b: 24, l: 24 },
        scene: {
          aspectmode: 'manual',
          aspectratio: gpsAspectRatio,
          xaxis: { title: 'Longitude', gridcolor: '#30343a' },
          yaxis: { title: 'Latitude', gridcolor: '#30343a' },
          zaxis: { title: 'Height (m)', gridcolor: '#30343a' },
          bgcolor: 'rgba(0,0,0,0)'
        }
      },
      { responsive: true, displaylogo: false, scrollZoom: true }
    ).then(() => Plotly3D.Plots.resize(plotElement));

    return () => {
      Plotly3D.purge(plotElement);
    };
  }, [gpsAspectRatio, gpsTracks, isActive, mode]);

  const toggleSelected = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  };

  const selectedCount = selectedIds.length;
  const gpsCount = gpsTracks.length;

  return (
    <section className="compare-view">
      <aside className="compare-selector panel">
        <div className="panel-header">
          <h2>Compare</h2>
          <span>{selectedCount} selected</span>
        </div>
        <label>
          <span className="summary-label">Search</span>
          <input
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Flight, altimeter, location..."
            type="search"
            value={searchText}
          />
        </label>
        <div className="compare-flight-list">
          {filteredFlights.map((flight) => (
            <div className="compare-flight-group" key={flight.directoryName}>
              <div className="compare-flight-heading">
                <span>{flight.directoryName}</span>
                <small>{flight.location || 'No location'}</small>
              </div>
              {flight.altimeters.map((altimeter) => (
                <label className="checkbox-row compare-checkbox" key={altimeter.id}>
                  <input
                    checked={selectedIds.includes(altimeter.altimeterDirectory)}
                    onChange={() => toggleSelected(altimeter.altimeterDirectory)}
                    type="checkbox"
                  />
                  <span>{altimeter.altimeterDirectoryName}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <div className="compare-main">
        <header className="compare-toolbar panel">
          <div className="segmented-control">
            <button className={mode === 'plot2d' ? 'selected' : ''} onClick={() => setMode('plot2d')} type="button">
              2D Plot
            </button>
            <button className={mode === 'plot3d' ? 'selected' : ''} onClick={() => setMode('plot3d')} type="button">
              3D Graph
            </button>
            <button className={mode === 'map2d' ? 'selected' : ''} onClick={() => setMode('map2d')} type="button">
              Flight Map
            </button>
            <button className={mode === 'map3d' ? 'selected' : ''} onClick={() => setMode('map3d')} type="button">
              Flight Map 3D
            </button>
          </div>
          <label>
            <span className="summary-label">2D metric</span>
            <select
              disabled={mode !== 'plot2d'}
              onChange={(event) => setMetric(event.target.value as CompareMetric)}
              value={metric}
            >
              <option value="altitude">Altitude / height (m)</option>
              <option value="velocity">Velocity (m/s)</option>
              <option value="acceleration">Acceleration (m/s²)</option>
              <option value="all">All standard metrics</option>
            </select>
          </label>
          <button className="small-button" onClick={() => setShowFullData((current) => !current)} type="button">
            {showFullData ? 'Flight Window' : 'Full Data'}
          </button>
        </header>

        <div className="compare-status">
          <span>{datasets.length} loaded</span>
          <span>{gpsCount} with GPS / 3D</span>
          {loadError ? <span className="error-text">{loadError}</span> : null}
        </div>

        <div className="compare-plot-area">
          {selectedCount === 0 ? (
            <div className="viewer-panel">
              <h2>Compare Flights</h2>
              <p>Select one or more altimeters from the list. Multiple altimeters from the same flight can be selected together.</p>
            </div>
          ) : mode === 'map2d' || mode === 'map3d' ? (
            <CompareGpsMapView isActive={isActive} mode={mode} tracks={gpsTracks} />
          ) : (
            <div className="plot-surface" ref={plotRef} />
          )}
        </div>
      </div>
    </section>
  );
}
