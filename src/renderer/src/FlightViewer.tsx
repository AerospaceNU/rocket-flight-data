import { useEffect, useMemo, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { AttributeEditor, ensureRequiredAttributes, hasRequiredAttributes } from './AttributeEditor';
import type { CustomAttribute, FlightSummary, ImportedDataset } from './importTypes';

const REQUIRED_ATTRIBUTE_KEYS = ['motor'];
const MULTILINE_ATTRIBUTE_KEYS = ['flight_notes'];
const ENSURED_ATTRIBUTE_KEYS = [...REQUIRED_ATTRIBUTE_KEYS, ...MULTILINE_ATTRIBUTE_KEYS];

type FlightViewerProps = {
  flight: FlightSummary | null;
  isActive: boolean;
  selectedAltimeterDirectory?: string;
  onDatasetUpdated: () => Promise<FlightSummary[]>;
};

type ViewerSection = 'attributes' | 'plot2d' | 'plot3d' | 'raw';

type EventMarker = {
  label: string;
  time: number;
  rowIndex: number;
  color: string;
};

type PlotHoverPoint = {
  x: number | string;
  y: number;
  data: {
    name?: string;
  };
};

type PlotHoverEvent = {
  points?: PlotHoverPoint[];
};

type PlotElement = HTMLElement & {
  on?: (eventName: string, callback: (event: PlotHoverEvent) => void) => void;
  removeAllListeners?: (eventName: string) => void;
};

const PAGE_SIZE = 250;
const FLIGHT_STATE_NAMES: Record<number, string> = {
  0: 'PRE_FLIGHT',
  1: 'ASCENT',
  2: 'DESCENT',
  3: 'POST_FLIGHT'
};
const EASYMINI_STATE_NAMES: Record<number, string> = {
  3: 'boost',
  5: 'coast',
  6: 'drogue',
  7: 'main',
  8: 'landed'
};

function defaultSeries(headers: string[]) {
  const preferred = [
    'altitudeM',
    'altitude',
    'velocityMS',
    'accelerationMSS',
    'height',
    'speed',
    'acceleration',
    'altitudeFt',
    'velocityFtS'
  ];
  const indexes = preferred
    .map((name) => headers.indexOf(name))
    .filter((index) => index > 0);

  return indexes.length > 0
    ? indexes
    : headers.map((_, index) => index).filter((index) => index > 0).slice(0, 3);
}

function parseNumber(value: string | undefined) {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : null;
}

function getColumnIndex(headers: string[], name: string) {
  const index = headers.indexOf(name);
  return index >= 0 ? index : null;
}

type TimeColumnDefinition = {
  names: string[];
  secondsPerUnit: number;
  relativeToFirstValue: boolean;
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

function normalizedHeader(header: string) {
  return header.trim().toLowerCase();
}

function getTimeColumn(headers: string[]) {
  const normalizedHeaders = headers.map(normalizedHeader);

  for (const definition of TIME_COLUMNS) {
    const index = normalizedHeaders.findIndex((header) => definition.names.includes(header));

    if (index >= 0) {
      return { ...definition, index };
    }
  }

  return null;
}

function buildXAxis(dataset: ImportedDataset) {
  const timeColumn = getTimeColumn(dataset.headers);

  if (!timeColumn) {
    return {
      values: dataset.rows.map((_, index) => index),
      title: 'Row',
      hoverLabel: 'row'
    };
  }

  const firstTimeValue =
    dataset.rows
      .map((row) => parseNumber(row[timeColumn.index]))
      .find((value) => value !== null) ?? 0;

  return {
    values: dataset.rows.map((row, index) => {
      const timeValue = parseNumber(row[timeColumn.index]);
      if (timeValue === null) {
        return index;
      }

      const relativeValue = timeColumn.relativeToFirstValue ? timeValue - firstTimeValue : timeValue;
      return relativeValue * timeColumn.secondsPerUnit;
    }),
    title: 'Time (s)',
    hoverLabel: 'time'
  };
}

function buildEventMarkers(dataset: ImportedDataset, xValues: number[]) {
  const flightStateIndex = getColumnIndex(dataset.headers, 'flightState');
  const easyMiniStateIndex = getColumnIndex(dataset.headers, 'state');
  const stateIndex = flightStateIndex ?? easyMiniStateIndex;
  const stateNameIndex = getColumnIndex(dataset.headers, 'state_name');
  const drogueFiredIndex = getColumnIndex(dataset.headers, 'drogueFired');
  const mainFiredIndex = getColumnIndex(dataset.headers, 'mainFired');
  const attributes = dataset.attributes.reduce<Record<string, string>>((record, attribute) => {
    record[attribute.key] = attribute.value;
    return record;
  }, {});
  const events: EventMarker[] = [];
  let launchTime: number | null = null;
  let flightEndTime: number | null = null;

  for (let index = 1; index < dataset.rows.length; index += 1) {
    if (stateIndex !== null) {
      const previousState = Number.parseInt(dataset.rows[index - 1]?.[stateIndex] ?? '', 10);
      const currentState = Number.parseInt(dataset.rows[index]?.[stateIndex] ?? '', 10);

      if (Number.isFinite(previousState) && Number.isFinite(currentState) && previousState !== currentState) {
        const previousName =
          stateNameIndex !== null
            ? dataset.rows[index - 1]?.[stateNameIndex]
            : flightStateIndex !== null
              ? FLIGHT_STATE_NAMES[previousState]
              : EASYMINI_STATE_NAMES[previousState];
        const currentName =
          stateNameIndex !== null
            ? dataset.rows[index]?.[stateNameIndex]
            : flightStateIndex !== null
              ? FLIGHT_STATE_NAMES[currentState]
              : EASYMINI_STATE_NAMES[currentState];
        events.push({
          label: `${previousName ?? previousState} -> ${currentName ?? currentState}`,
          time: xValues[index],
          rowIndex: index,
          color: '#74c69d'
        });

        if (
          launchTime === null &&
          ((flightStateIndex !== null && previousState === 0 && currentState !== 0) ||
            (easyMiniStateIndex !== null && currentState === 5))
        ) {
          launchTime = xValues[index];
        }

        if (
          (flightStateIndex !== null && currentState === 3) ||
          (easyMiniStateIndex !== null && currentState === 8)
        ) {
          flightEndTime = xValues[index];
        }
      }
    }

    if (
      drogueFiredIndex !== null &&
      dataset.rows[index - 1]?.[drogueFiredIndex] === '0' &&
      dataset.rows[index]?.[drogueFiredIndex] === '1'
    ) {
      events.push({
        label: 'DROGUE FIRED',
        time: xValues[index],
        rowIndex: index,
        color: '#b07cff'
      });
    }

    if (
      mainFiredIndex !== null &&
      dataset.rows[index - 1]?.[mainFiredIndex] === '0' &&
      dataset.rows[index]?.[mainFiredIndex] === '1'
    ) {
      events.push({
        label: 'MAIN FIRED',
        time: xValues[index],
        rowIndex: index,
        color: '#69a7ff'
      });
    }
  }

  const drogueAt = parseNumber(attributes.drogue_at?.replace(/[^0-9.+-]/g, ''));
  const mainAt = parseNumber(attributes.main_at?.replace(/[^0-9.+-]/g, ''));

  if (drogueAt !== null) {
    events.push({
      label: 'DROGUE',
      time: drogueAt,
      rowIndex: xValues.findIndex((time) => time >= drogueAt),
      color: '#b07cff'
    });
  }

  if (mainAt !== null) {
    events.push({
      label: 'MAIN',
      time: mainAt,
      rowIndex: xValues.findIndex((time) => time >= mainAt),
      color: '#69a7ff'
    });
  }

  const sortedEvents = events.sort((left, right) => left.time - right.time);
  const firstEventTime = sortedEvents[0]?.time ?? xValues[0] ?? 0;
  const lastEventTime = sortedEvents[sortedEvents.length - 1]?.time ?? xValues[xValues.length - 1] ?? 0;

  return {
    events: sortedEvents,
    launchTime,
    flightStartTime: launchTime ?? firstEventTime,
    flightEndTime: flightEndTime ?? lastEventTime
  };
}

function buildWindow(xValues: number[], flightStartTime: number, flightEndTime: number) {
  const minTime = xValues[0] ?? 0;
  const maxTime = xValues[xValues.length - 1] ?? minTime;

  return {
    start: Math.max(minTime, flightStartTime - 20),
    end: Math.min(maxTime, flightEndTime + 20)
  };
}

function axisRange(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  return Math.max(0, max - min);
}

function getColumnIndexByAliases(headers: string[], aliases: string[]) {
  const normalizedHeaders = headers.map(normalizedHeader);

  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(alias.toLowerCase());
    if (index >= 0) {
      return index;
    }
  }

  return null;
}

export function FlightViewer({
  flight,
  isActive,
  selectedAltimeterDirectory,
  onDatasetUpdated
}: FlightViewerProps) {
  const [selectedDirectory, setSelectedDirectory] = useState('');
  const [dataset, setDataset] = useState<ImportedDataset | null>(null);
  const [loadError, setLoadError] = useState('');
  const [activeSection, setActiveSection] = useState<ViewerSection>('attributes');
  const [attributes, setAttributes] = useState<CustomAttribute[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<number[]>([]);
  const [hoverText, setHoverText] = useState('Hover over the chart to inspect values.');
  const [showFullData, setShowFullData] = useState(false);
  const [rawPage, setRawPage] = useState(0);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const plot2dRef = useRef<HTMLDivElement | null>(null);
  const plot3dRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!flight) {
      setSelectedDirectory('');
      return;
    }

    setSelectedDirectory((current) => {
      const requested = selectedAltimeterDirectory;
      if (requested && flight.altimeters.some((altimeter) => altimeter.altimeterDirectory === requested)) {
        return requested;
      }

      if (current && flight.altimeters.some((altimeter) => altimeter.altimeterDirectory === current)) {
        return current;
      }

      return flight.altimeters[0]?.altimeterDirectory ?? '';
    });
  }, [flight, selectedAltimeterDirectory]);

  useEffect(() => {
    if (!selectedDirectory) {
      setDataset(null);
      return;
    }

    let ignore = false;
    setLoadError('');

    window.appBridge
      .readDataset(selectedDirectory)
      .then((nextDataset) => {
        if (ignore) return;
        setDataset(nextDataset);
        setAttributes(ensureRequiredAttributes(nextDataset.attributes, ENSURED_ATTRIBUTE_KEYS));
        setSelectedSeries(defaultSeries(nextDataset.headers));
        setShowFullData(false);
        setRawPage(0);
      })
      .catch((error: Error) => {
        if (!ignore) {
          setLoadError(error.message);
        }
      });

    return () => {
      ignore = true;
    };
  }, [selectedDirectory]);

  const hasAttributeChanges = useMemo(() => {
    if (!dataset) return false;
    const ensured = ensureRequiredAttributes(dataset.attributes, ENSURED_ATTRIBUTE_KEYS);
    return JSON.stringify(attributes) !== JSON.stringify(ensured);
  }, [attributes, dataset]);

  const hasRequiredFilled = hasRequiredAttributes(attributes, REQUIRED_ATTRIBUTE_KEYS);

  const rawXAxis = useMemo(
    () => (dataset ? buildXAxis(dataset) : { values: [], title: 'Row', hoverLabel: 'row' }),
    [dataset]
  );

  const rawEventData = useMemo(() => {
    if (!dataset) {
      return {
        events: [] as EventMarker[],
        launchTime: null as number | null,
        flightStartTime: 0,
        flightEndTime: 0
      };
    }
    return buildEventMarkers(dataset, rawXAxis.values);
  }, [dataset, rawXAxis.values]);

  const launchOffset = rawEventData.launchTime ?? 0;

  const xAxis = useMemo(
    () =>
      launchOffset === 0
        ? rawXAxis
        : { ...rawXAxis, values: rawXAxis.values.map((value) => value - launchOffset) },
    [rawXAxis, launchOffset]
  );
  const xValues = xAxis.values;

  const eventData = useMemo(
    () =>
      launchOffset === 0
        ? rawEventData
        : {
            ...rawEventData,
            events: rawEventData.events.map((event) => ({ ...event, time: event.time - launchOffset })),
            flightStartTime: rawEventData.flightStartTime - launchOffset,
            flightEndTime: rawEventData.flightEndTime - launchOffset
          },
    [rawEventData, launchOffset]
  );

  const dataWindow = useMemo(
    () => buildWindow(xValues, eventData.flightStartTime, eventData.flightEndTime),
    [eventData.flightEndTime, eventData.flightStartTime, xValues]
  );

  const visibleIndexes = useMemo(() => {
    if (showFullData) {
      return dataset?.rows.map((_, index) => index) ?? [];
    }

    return xValues
      .map((time, index) => ({ time, index }))
      .filter(({ time }) => time >= dataWindow.start && time <= dataWindow.end)
      .map(({ index }) => index);
  }, [dataWindow.end, dataWindow.start, dataset, showFullData, xValues]);

  const visibleRows = useMemo(
    () => visibleIndexes.map((index) => dataset?.rows[index] ?? []),
    [dataset, visibleIndexes]
  );
  const visibleXValues = useMemo(() => visibleIndexes.map((index) => xValues[index]), [visibleIndexes, xValues]);
  const visibleEvents = useMemo(
    () =>
      eventData.events.filter((event) =>
        showFullData ? true : event.time >= dataWindow.start && event.time <= dataWindow.end
      ),
    [dataWindow.end, dataWindow.start, eventData.events, showFullData]
  );

  const eventLabelLevels = useMemo(() => {
    const lastVisible = visibleXValues[visibleXValues.length - 1];
    const firstVisible = visibleXValues[0];
    const visibleRange =
      typeof lastVisible === 'number' && typeof firstVisible === 'number' ? lastVisible - firstVisible : 0;
    // Threshold roughly approximates a rotated label's horizontal footprint (~font height)
    // expressed in time units: assume ~12px of label width on a ~800px plot.
    const threshold = visibleRange > 0 ? Math.max(visibleRange * 0.018, 1e-6) : 0;

    const indexed = visibleEvents.map((event, index) => ({ event, index }));
    indexed.sort((left, right) => left.event.time - right.event.time);

    const levels = new Array<number>(visibleEvents.length).fill(0);
    const active: { time: number; level: number }[] = [];

    for (const { event, index } of indexed) {
      while (active.length > 0 && event.time - active[0].time > threshold) {
        active.shift();
      }
      const used = new Set(active.map((entry) => entry.level));
      let level = 0;
      while (used.has(level)) level += 1;
      levels[index] = level;
      active.push({ time: event.time, level });
    }

    return levels;
  }, [visibleEvents, visibleXValues]);
  const gpsColumns = useMemo(() => {
    if (!dataset) {
      return null;
    }

    const latitudeIndex = getColumnIndexByAliases(dataset.headers, ['latitude', 'lat']);
    const longitudeIndex = getColumnIndexByAliases(dataset.headers, ['longitude', 'lon', 'lng']);
    const altitudeIndex = getColumnIndexByAliases(dataset.headers, ['altitude', 'altitude_m', 'altitudem']);

    if (latitudeIndex === null || longitudeIndex === null || altitudeIndex === null) {
      return null;
    }

    return { latitudeIndex, longitudeIndex, altitudeIndex };
  }, [dataset]);
  const gpsPoints = useMemo(() => {
    if (!gpsColumns) {
      return [];
    }

    return visibleRows
      .map((row, index) => ({
        latitude: parseNumber(row[gpsColumns.latitudeIndex]),
        longitude: parseNumber(row[gpsColumns.longitudeIndex]),
        altitude: parseNumber(row[gpsColumns.altitudeIndex]),
        time: visibleXValues[index]
      }))
      .filter(
        (point): point is { latitude: number; longitude: number; altitude: number; time: number } =>
          point.latitude !== null &&
          point.longitude !== null &&
          point.altitude !== null &&
          Number.isFinite(point.time)
      );
  }, [gpsColumns, visibleRows, visibleXValues]);
  const gpsAspectRatio = useMemo(() => {
    if (gpsPoints.length === 0) {
      return { x: 1, y: 1, z: 1 };
    }

    const lonRange = axisRange(gpsPoints.map((point) => point.longitude));
    const latRange = axisRange(gpsPoints.map((point) => point.latitude));
    const horizontalRange = Math.max(lonRange, latRange, 1e-9);
    const xRatio = Math.max(lonRange / horizontalRange, 1e-6);
    const yRatio = Math.max(latRange / horizontalRange, 1e-6);

    return {
      x: xRatio,
      y: yRatio,
      z: 1
    };
  }, [gpsPoints]);

  useEffect(() => {
    setRawPage(0);
  }, [dataset, showFullData]);

  useEffect(() => {
    const plotElement = plot2dRef.current;
    if (!isActive || !plotElement || !dataset || activeSection !== 'plot2d') {
      return;
    }

    const traces = selectedSeries.map((seriesIndex) => ({
      x: visibleXValues,
      y: visibleRows.map((row) => parseNumber(row[seriesIndex]) ?? Number.NaN),
      name: dataset.headers[seriesIndex],
      mode: 'lines',
      type: 'scatter',
      hoverinfo: 'none'
    }));

    Plotly.newPlot(
      plotElement,
      traces,
      {
        autosize: true,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#e4e7eb' },
        margin: { t: 24, r: 24, b: 48, l: 64 },
        hovermode: 'x',
        shapes: visibleEvents.map((event) => ({
          type: 'line',
          x0: event.time,
          x1: event.time,
          y0: 0,
          y1: 1,
          yref: 'paper',
          line: { color: event.color, width: 1, dash: 'dash' }
        })),
        annotations: visibleEvents.map((event, index) => ({
          x: event.time,
          y: 1,
          yref: 'paper',
          yanchor: 'top',
          yshift: -(eventLabelLevels[index] ?? 0) * 90,
          text: event.label,
          showarrow: false,
          textangle: -90,
          xanchor: 'right',
          font: { color: event.color, size: 10 }
        })),
        xaxis: {
          title: xAxis.title,
          gridcolor: '#30343a',
          showspikes: true,
          spikemode: 'across',
          spikesnap: 'cursor',
          spikedash: 'dash',
          spikecolor: '#aab2bd',
          spikethickness: 1
        },
        yaxis: {
          title: 'Value',
          gridcolor: '#30343a'
        },
        legend: {
          orientation: 'h',
          yanchor: 'bottom',
          y: 1.02,
          xanchor: 'right',
          x: 1
        }
      },
      {
        responsive: true,
        displaylogo: false,
        scrollZoom: true
      }
    ).then(() => {
      const interactivePlot = plotElement as PlotElement;
      interactivePlot.removeAllListeners?.('plotly_hover');
      interactivePlot.removeAllListeners?.('plotly_unhover');
      interactivePlot.on?.('plotly_hover', (event) => {
        if (!event.points?.length) return;

        const hoveredX = event.points[0]?.x;
        const hoverValue = typeof hoveredX === 'number' ? hoveredX.toFixed(3) : hoveredX;
        const values = event.points
          .map((point) => `${point.data.name ?? 'series'}: ${point.y.toFixed(3)}`)
          .join('   ');
        setHoverText(`${xAxis.hoverLabel}: ${hoverValue}${xAxis.hoverLabel === 'time' ? ' s' : ''}   ${values}`);
      });
      interactivePlot.on?.('plotly_unhover', () => {
        setHoverText('Hover over the chart to inspect values.');
      });
      Plotly.Plots.resize(plotElement);
    });

    return () => {
      Plotly.purge(plotElement);
    };
  }, [
    activeSection,
    dataset,
    eventLabelLevels,
    isActive,
    selectedSeries,
    visibleEvents,
    visibleRows,
    visibleXValues,
    xAxis.hoverLabel,
    xAxis.title
  ]);

  useEffect(() => {
    const plotElement = plot3dRef.current;
    if (!isActive || !plotElement || !dataset || activeSection !== 'plot3d' || !gpsColumns) {
      return;
    }

    Plotly.newPlot(
      plotElement,
      [
        {
          type: 'scatter3d',
          mode: 'lines+markers',
          x: gpsPoints.map((point) => point.longitude),
          y: gpsPoints.map((point) => point.latitude),
          z: gpsPoints.map((point) => point.altitude),
          text: gpsPoints.map((point) => `t=${point.time.toFixed(2)}s`),
          hovertemplate:
            'Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Alt: %{z:.2f} m<br>%{text}<extra></extra>',
          line: {
            width: 4,
            color: gpsPoints.map((point) => point.time),
            colorscale: 'Turbo'
          },
          marker: {
            size: 3,
            color: gpsPoints.map((point) => point.time),
            colorscale: 'Turbo',
            showscale: true,
            colorbar: { title: 'Time (s)' }
          }
        }
      ],
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
          zaxis: { title: 'Altitude (m)', gridcolor: '#30343a' },
          bgcolor: 'rgba(0,0,0,0)'
        }
      },
      {
        responsive: true,
        displaylogo: false,
        scrollZoom: true
      }
    ).then(() => {
      Plotly.Plots.resize(plotElement);
    });

    return () => {
      Plotly.purge(plotElement);
    };
  }, [activeSection, dataset, gpsAspectRatio, gpsColumns, gpsPoints, isActive]);

  const saveAttributes = async () => {
    if (!dataset || !hasAttributeChanges) return;

    setIsSaving(true);
    setSaveStatus('');
    setSaveError('');

    try {
      const nextDataset = await window.appBridge.saveDatasetAttributes({
        datasetDirectory: selectedDirectory,
        attributes
      });
      setDataset(nextDataset);
      setAttributes(nextDataset.attributes);
      setSaveStatus('Attributes saved.');
      await onDatasetUpdated();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save attributes.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!flight) {
    return <div className="muted-text">Flight is not available in the current directory.</div>;
  }

  if (loadError) {
    return <div className="error-text">{loadError}</div>;
  }

  const numericSeries =
    dataset?.headers.map((header, index) => ({ header, index })).filter((series) => series.index > 0) ?? [];
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const boundedPage = Math.min(rawPage, totalPages - 1);
  const pagedRows = visibleRows.slice(boundedPage * PAGE_SIZE, (boundedPage + 1) * PAGE_SIZE);

  return (
    <div className="viewer">
      <header className="viewer-header">
        <div>
          <h2>{flight.directoryName}</h2>
        </div>
        <button
          className="small-button"
          onClick={() => setShowFullData((current) => !current)}
          type="button"
        >
          {showFullData ? 'Flight Window' : 'Full Data'}
        </button>
      </header>

      <nav className="altimeter-tabbar" aria-label="Altimeters">
        {flight.altimeters.map((altimeter) => (
          <button
            className={selectedDirectory === altimeter.altimeterDirectory ? 'active' : ''}
            key={altimeter.id}
            onClick={() => setSelectedDirectory(altimeter.altimeterDirectory)}
            type="button"
          >
            {altimeter.altimeterDirectoryName}
          </button>
        ))}
      </nav>

      <div className="viewer-body">
        <nav className="view-sidebar" aria-label="Dataset views">
          <button
            className={activeSection === 'attributes' ? 'active' : ''}
            onClick={() => setActiveSection('attributes')}
            type="button"
          >
            Attributes
          </button>
          <button
            className={activeSection === 'plot2d' ? 'active' : ''}
            onClick={() => setActiveSection('plot2d')}
            type="button"
          >
            2D Plot
          </button>
          <button
            className={activeSection === 'plot3d' ? 'active' : ''}
            onClick={() => setActiveSection('plot3d')}
            type="button"
          >
            3D Plot
          </button>
          <button
            className={activeSection === 'raw' ? 'active' : ''}
            onClick={() => setActiveSection('raw')}
            type="button"
          >
            Raw Data
          </button>
        </nav>

        <div className="viewer-content">
          {!dataset ? <div className="muted-text">Loading dataset...</div> : null}

          {dataset && activeSection === 'attributes' ? (
            <section className="viewer-panel">
              <div className="panel-header">
                <h2>Attributes</h2>
                <span>{dataset.summary.altimeterDirectoryName}</span>
              </div>
              <AttributeEditor
                attributes={attributes}
                emptyText="No attributes."
                onChange={(next) => setAttributes(ensureRequiredAttributes(next, ENSURED_ATTRIBUTE_KEYS))}
                requiredKeys={REQUIRED_ATTRIBUTE_KEYS}
                multilineKeys={MULTILINE_ATTRIBUTE_KEYS}
              />
              <footer className="import-actions">
                {saveStatus ? <div className="success-text">{saveStatus}</div> : null}
                {saveError ? <div className="error-text">{saveError}</div> : null}
                {!hasRequiredFilled ? (
                  <div className="warning-text">Motor is required.</div>
                ) : null}
                <button
                  className="primary-button"
                  disabled={!hasAttributeChanges || !hasRequiredFilled || isSaving}
                  onClick={saveAttributes}
                  type="button"
                >
                  {isSaving ? 'Saving' : 'Save Attributes'}
                </button>
              </footer>
            </section>
          ) : null}

          {dataset && activeSection === 'plot2d' ? (
            <section className="plot-layout">
              <aside className="series-panel">
                <div className="section-title">Series</div>
                <div className="series-list">
                  {numericSeries.map((series) => (
                    <label className="checkbox-row" key={series.index}>
                      <input
                        checked={selectedSeries.includes(series.index)}
                        onChange={(event) => {
                          setSelectedSeries((current) =>
                            event.target.checked
                              ? [...current, series.index]
                              : current.filter((index) => index !== series.index)
                          );
                        }}
                        type="checkbox"
                      />
                      {series.header}
                    </label>
                  ))}
                </div>
              </aside>
              <div className="plot-main">
                <div className="hover-dashboard">{hoverText}</div>
                <div className="plot-surface" ref={plot2dRef} />
              </div>
            </section>
          ) : null}

          {dataset && activeSection === 'plot3d' ? (
            <section className="plot3d-layout">
              {gpsColumns ? (
                <div className="plot-surface" ref={plot3dRef} />
              ) : (
                <div className="viewer-panel">
                  <h2>3D Plot</h2>
                  <p>No GPS 3D dataset is available for this altimeter.</p>
                </div>
              )}
            </section>
          ) : null}

          {dataset && activeSection === 'raw' ? (
            <section className="raw-data-shell">
              <div className="raw-toolbar">
                <span>
                  Rows {visibleRows.length === 0 ? 0 : boundedPage * PAGE_SIZE + 1}-
                  {Math.min((boundedPage + 1) * PAGE_SIZE, visibleRows.length)} of {visibleRows.length}
                </span>
                <div className="pager">
                  <button
                    className="small-button"
                    disabled={boundedPage === 0}
                    onClick={() => setRawPage((page) => Math.max(0, page - 1))}
                    type="button"
                  >
                    Previous
                  </button>
                  <span>
                    {boundedPage + 1} / {totalPages}
                  </span>
                  <button
                    className="small-button"
                    disabled={boundedPage >= totalPages - 1}
                    onClick={() => setRawPage((page) => Math.min(totalPages - 1, page + 1))}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              </div>
              <div className="raw-data-panel">
                <table className="data-table">
                  <thead>
                    <tr>
                      {dataset.headers.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row, rowIndex) => (
                      <tr key={`${boundedPage}-${rowIndex}`}>
                        {dataset.headers.map((header, columnIndex) => (
                          <td key={`${rowIndex}-${header}`}>{row[columnIndex]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
