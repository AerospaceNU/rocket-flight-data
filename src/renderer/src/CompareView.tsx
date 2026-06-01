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
import { axisRange, parseNumber } from './telemetry/core';
import { buildEventWindow, getImporterId } from './telemetry/events';
import { buildGpsPoints, findAltitudeIndex, findGpsColumns } from './telemetry/gps';
import { buildXAxis } from './telemetry/time';

type CompareViewProps = {
  config: ImportConfig | null;
  flights: FlightSummary[];
  isActive: boolean;
};

type CompareMode = 'plot2d' | 'plot3d' | 'map2d' | 'map3d';
type CompareMetric = 'altitude' | 'velocity' | 'acceleration' | 'all';

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
  color: [number, number, number, number],
  autoDetect: boolean
): CompareDataset {
  const rawXValues = buildXAxis(dataset, { autoDetect }).values;
  const window = buildEventWindow(dataset, rawXValues, { autoDetect });
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
  const gpsPositionColumns = findGpsColumns(dataset.headers, dataset.rows, { autoDetect });
  const altitudeIndex = findAltitudeIndex(dataset.headers);
  const launchAltitude =
    altitudeIndex === null
      ? 0
      : visibleRows.map((row) => parseNumber(row[altitudeIndex])).find((value) => value !== null) ?? 0;
  const gpsPoints =
    gpsPositionColumns && altitudeIndex !== null
      ? buildGpsPoints(
          visibleRows,
          visibleXValues,
          { ...gpsPositionColumns, altitudeIndex },
          launchAltitude
        )
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

export function CompareView({ config, flights, isActive }: CompareViewProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [mode, setMode] = useState<CompareMode>('plot2d');
  const [metric, setMetric] = useState<CompareMetric>('altitude');
  const [showFullData, setShowFullData] = useState(false);
  const [sanitizeData, setSanitizeData] = useState(true);
  const [autoDetect, setAutoDetect] = useState(true);
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
        const dataset = await window.appBridge.readDataset(id, { sanitize: sanitizeData });
        return prepareDataset(
          dataset,
          altimeter,
          config,
          showFullData,
          COLORS[index % COLORS.length],
          autoDetect
        );
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
  }, [altimeters, sanitizeData, autoDetect, config, selectedIds, showFullData]);

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
          <label className="checkbox-row toolbar-checkbox">
            <input
              checked={sanitizeData}
              onChange={(event) => setSanitizeData(event.target.checked)}
              type="checkbox"
            />
            <span title="Blank out-of-range / corrupt values while parsing">Sanitize data</span>
          </label>
          <label className="checkbox-row toolbar-checkbox">
            <input
              checked={autoDetect}
              onChange={(event) => setAutoDetect(event.target.checked)}
              type="checkbox"
            />
            <span title="Auto-detect time units, GPS columns, and flight events">Auto-detect</span>
          </label>
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
