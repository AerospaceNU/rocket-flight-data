import { useEffect, useMemo, useRef, useState } from 'react';
import Plotly2D from 'plotly.js-basic-dist-min';
import { CompareGpsMapView, type CompareGpsTrack } from './CompareGpsMapView';
import type {
  DisplayUnitSystem,
  FlightSummary,
  ImportedAltimeterSummary,
  ImportedDataset,
  ImportConfig
} from './importTypes';
import type { GpsMapPoint } from './GpsMapView';
import {
  attachPlotHoverDashboard,
  computeEventLabelShifts,
  HOVER_DASHBOARD_IDLE_TEXT
} from './plot2dShared';
import {
  buildCompareGpsPlot3dTraces,
  computeGpsPlot3dAspectRatio,
  purgeGpsPlot3d,
  renderGpsPlot3d
} from './plot3dShared';
import { parseNumber } from './telemetry/core';
import {
  parseDisplaySeriesValue,
  seriesDisplayLabel,
  yAxisTitleForSeries
} from './plotUnits';
import { displayUnitLabel, type ColumnUnit, type ColumnUnitMap } from '../../shared/units';
import { buildEventMarkers, buildEventWindow, getImporterId, type EventMarker } from './telemetry/events';
import { buildGpsPoints, findAltitudeIndex, findGpsColumns } from './telemetry/gps';
import { buildXAxis } from './telemetry/time';

type CompareViewProps = {
  config: ImportConfig | null;
  displayUnits: DisplayUnitSystem;
  flights: FlightSummary[];
  isActive: boolean;
};

type CompareMode = 'plot2d' | 'plot3d' | 'map2d' | 'map3d';

type CompareDataset = {
  id: string;
  label: string;
  rocketName: string;
  altimeterName: string;
  importerId: string;
  dataset: ImportedDataset;
  xValues: number[];
  visibleRows: string[][];
  visibleXValues: number[];
  eventMarkers: EventMarker[];
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
const LENGTH_METERS: ColumnUnit = { family: 'length', unit: 'm' };

function colorString(color: [number, number, number, number], alphaScale = 1) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.min(1, (color[3] / 255) * alphaScale)})`;
}

function prepareDataset(
  dataset: ImportedDataset,
  altimeter: ImportedAltimeterSummary,
  showFullData: boolean,
  color: [number, number, number, number],
  autoDetect: boolean
): CompareDataset {
  const rawXValues = buildXAxis(dataset, { autoDetect }).values;
  const rawEventData = buildEventMarkers(dataset, rawXValues, { autoDetect });
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
  const visibleStart = visibleXValues[0] ?? xValues[0] ?? 0;
  const visibleEnd = visibleXValues[visibleXValues.length - 1] ?? xValues[xValues.length - 1] ?? visibleStart;
  const eventMarkers = rawEventData.events
    .map((event) => ({ ...event, time: event.time - window.launchOffset }))
    .filter((event) => showFullData || (event.time >= visibleStart && event.time <= visibleEnd));
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
    rocketName: altimeter.flightDirectoryName,
    altimeterName: altimeter.altimeterDirectoryName,
    importerId: getImporterId(dataset),
    dataset,
    xValues,
    visibleRows,
    visibleXValues,
    eventMarkers,
    gpsPoints,
    color
  };
}

function seriesValues(entry: CompareDataset, header: string, displayUnits: DisplayUnitSystem) {
  const index = entry.dataset.headers.indexOf(header);
  if (index < 0) return null;
  return entry.visibleRows.map((row) =>
    parseDisplaySeriesValue(row[index], header, entry.dataset.columnUnits, displayUnits)
  );
}

export function CompareView({ config, displayUnits, flights, isActive }: CompareViewProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [mode, setMode] = useState<CompareMode>('plot2d');
  const [selectedSeriesHeaders, setSelectedSeriesHeaders] = useState<string[]>([]);
  const [hoverText, setHoverText] = useState(HOVER_DASHBOARD_IDLE_TEXT);
  const [showFullData, setShowFullData] = useState(false);
  const [sanitizeData, setSanitizeData] = useState(true);
  const [autoDetect, setAutoDetect] = useState(true);
  const [showEvents, setShowEvents] = useState(false);
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
  }, [altimeters, sanitizeData, autoDetect, selectedIds, showFullData]);

  const seriesOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { header: string; columnUnits: ColumnUnitMap }[] = [];

    for (const entry of datasets) {
      entry.dataset.headers.forEach((header, index) => {
        if (index === 0 || seen.has(header)) return;
        seen.add(header);
        options.push({ header, columnUnits: entry.dataset.columnUnits });
      });
    }

    return options;
  }, [datasets]);

  const defaultSelectedSeriesHeaders = useMemo(() => {
    const headers = new Set<string>();

    for (const entry of datasets) {
      const altitudeColumn = config?.altimeters.find(
        (altimeter) => altimeter.importerId === entry.importerId
      )?.standardColumns.altitudeMeters?.column;
      if (altitudeColumn && entry.dataset.headers.includes(altitudeColumn)) {
        headers.add(altitudeColumn);
      }
    }

    return Array.from(headers);
  }, [config, datasets]);

  const fallbackSelectedSeriesHeaders = useMemo(
    () => seriesOptions.slice(0, 3).map((series) => series.header),
    [seriesOptions]
  );
  const datasetSignature = useMemo(() => datasets.map((entry) => entry.id).join('|'), [datasets]);
  const defaultSeriesSignature = defaultSelectedSeriesHeaders.join('|');
  const fallbackSeriesSignature = fallbackSelectedSeriesHeaders.join('|');

  useEffect(() => {
    setSelectedSeriesHeaders(
      defaultSelectedSeriesHeaders.length > 0
        ? defaultSelectedSeriesHeaders
        : fallbackSelectedSeriesHeaders
    );
    setHoverText(HOVER_DASHBOARD_IDLE_TEXT);
  }, [datasetSignature, defaultSeriesSignature, fallbackSeriesSignature]);

  const traces2d = useMemo(
    () =>
      datasets.flatMap((entry) =>
        selectedSeriesHeaders.flatMap((header) => {
          const values = seriesValues(entry, header, displayUnits);
          if (!values) return [];
          return [
            {
              x: entry.visibleXValues,
              y: values,
              name: seriesDisplayLabel(
                `${entry.label} - ${header}`,
                header,
                entry.dataset.columnUnits,
                displayUnits
              ),
              mode: 'lines',
              type: 'scatter',
              line: { color: colorString(entry.color), width: 2 },
              hoverinfo: 'none'
            }
          ];
        })
      ),
    [datasets, displayUnits, selectedSeriesHeaders]
  );
  const yAxisTitle2d = useMemo(() => {
    const columnUnits: ColumnUnitMap = {};

    for (const entry of datasets) {
      for (const header of selectedSeriesHeaders) {
        if (!columnUnits[header] && entry.dataset.columnUnits[header]) {
          columnUnits[header] = entry.dataset.columnUnits[header];
        }
      }
    }

    return yAxisTitleForSeries(selectedSeriesHeaders, columnUnits, displayUnits);
  }, [datasets, displayUnits, selectedSeriesHeaders]);
  const compareEvents = useMemo(
    () =>
      showEvents
        ? datasets.flatMap((entry) =>
            entry.eventMarkers.map((event) => ({
              ...event,
              label: `${entry.label} - ${event.label}`
            }))
          )
        : [],
    [datasets, showEvents]
  );
  const compareVisibleXValues = useMemo(
    () => datasets.flatMap((entry) => entry.visibleXValues).sort((left, right) => left - right),
    [datasets]
  );
  const compareEventLabelShifts = useMemo(
    () => computeEventLabelShifts(compareEvents, compareVisibleXValues),
    [compareEvents, compareVisibleXValues]
  );

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
    return computeGpsPlot3dAspectRatio(points);
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
        hovermode: 'x',
        shapes: compareEvents.map((event) => ({
          type: 'line',
          x0: event.time,
          x1: event.time,
          y0: 0,
          y1: 1,
          yref: 'paper',
          line: { color: event.color, width: 1, dash: 'dash' }
        })),
        annotations: compareEvents.map((event, index) => ({
          x: event.time,
          y: 1,
          yref: 'paper',
          yanchor: 'top',
          yshift: compareEventLabelShifts[index] ?? 0,
          text: event.label,
          showarrow: false,
          textangle: -90,
          xanchor: 'right',
          font: { color: event.color, size: 10 }
        })),
        xaxis: {
          title: { text: 'Time(s)', standoff: 12 },
          automargin: true,
          gridcolor: '#30343a',
          showspikes: true,
          spikemode: 'across',
          spikesnap: 'cursor',
          spikedash: 'dash',
          spikecolor: '#aab2bd',
          spikethickness: 1
        },
        yaxis: { title: yAxisTitle2d, gridcolor: '#30343a' },
        legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1 }
      },
      { responsive: true, displaylogo: false, scrollZoom: true }
    ).then(() => {
      attachPlotHoverDashboard(plotElement, { hoverLabel: 'time' }, setHoverText);
      Plotly2D.Plots.resize(plotElement);
    });

    return () => {
      Plotly2D.purge(plotElement);
    };
  }, [compareEventLabelShifts, compareEvents, isActive, mode, traces2d, yAxisTitle2d]);

  useEffect(() => {
    const plotElement = plotRef.current;
    if (!isActive || !plotElement || mode !== 'plot3d') return;

    void renderGpsPlot3d(
      plotElement,
      buildCompareGpsPlot3dTraces(gpsTracks, displayUnits),
      gpsAspectRatio,
      `Height (${displayUnitLabel(LENGTH_METERS, displayUnits)})`
    );

    return () => {
      purgeGpsPlot3d(plotElement);
    };
  }, [displayUnits, gpsAspectRatio, gpsTracks, isActive, mode]);

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
          <label className="checkbox-row toolbar-checkbox">
            <input
              checked={showEvents}
              onChange={(event) => setShowEvents(event.target.checked)}
              type="checkbox"
            />
            <span title="Show flight event markers on the 2D plot">Show events</span>
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
          ) : mode === 'plot2d' ? (
            <section className="plot-layout">
              <aside className="series-panel">
                <div className="section-title">Series</div>
                <div className="series-list">
                  {seriesOptions.map((series) => (
                    <label className="checkbox-row" key={series.header}>
                      <input
                        checked={selectedSeriesHeaders.includes(series.header)}
                        onChange={(event) => {
                          setSelectedSeriesHeaders((current) =>
                            event.target.checked
                              ? [...current, series.header]
                              : current.filter((header) => header !== series.header)
                          );
                        }}
                        type="checkbox"
                      />
                      {seriesDisplayLabel(series.header, series.header, series.columnUnits, displayUnits)}
                    </label>
                  ))}
                </div>
              </aside>
              <div className="plot-main">
                <div className="hover-dashboard">{hoverText}</div>
                <div className="plot-surface" ref={plotRef} />
              </div>
            </section>
          ) : (
            <div className="plot-surface" ref={plotRef} />
          )}
        </div>
      </div>
    </section>
  );
}
