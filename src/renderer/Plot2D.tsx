import React, { useEffect, useMemo, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { FlightData } from '../shared/types';

/** Groups of column-name patterns we surface at the top of the series list. */
const SERIES_PRIORITY: { label: string; match: (c: string) => boolean }[] = [
  {
    label: 'Altitude',
    match: (c) => /^(baro\d*_alt|baroalt_agl|pos_z|gps_alt|altitudeM|unfiltAlt|fcb_altitude|unfilteredAltitudeM)$/i.test(c),
  },
  {
    label: 'Velocity',
    match: (c) => /^(vel_[xyz]|velocityMS|v_speed)$/i.test(c),
  },
  {
    label: 'Acceleration',
    match: (c) =>
      /^(acc_[xyz]|accel_[xyz]|imu\d+_accel_[xyz](_real)?|high_g_accel_[xyz](_real)?|accelerationMSS(_[xyz])?)$/i.test(c),
  },
];

function pickInitialSeries(numericColumns: string[], timeColumn: string | null): string[] {
  const ignore = new Set([timeColumn ?? '']);
  const picks: string[] = [];
  for (const group of SERIES_PRIORITY) {
    const col = numericColumns.find((c) => !ignore.has(c) && group.match(c));
    if (col) picks.push(col);
  }
  if (picks.length === 0) {
    const first = numericColumns.find((c) => !ignore.has(c));
    if (first) picks.push(first);
  }
  return picks;
}

function groupColumns(numericColumns: string[], timeColumn: string | null) {
  const seen = new Set<string>();
  const groups: { label: string; cols: string[] }[] = [];
  for (const g of SERIES_PRIORITY) {
    const cols = numericColumns.filter((c) => c !== timeColumn && g.match(c));
    cols.forEach((c) => seen.add(c));
    if (cols.length) groups.push({ label: g.label, cols });
  }
  const rest = numericColumns.filter((c) => c !== timeColumn && !seen.has(c));
  if (rest.length) groups.push({ label: 'Other', cols: rest });
  return groups;
}

export function Plot2D({ data }: { data: FlightData | null }) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initializedKey, setInitializedKey] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(true);
  const [trimToFlight, setTrimToFlight] = useState(true);

  useEffect(() => {
    if (!data) return;
    const sig = data.columns.join('|');
    if (sig === initializedKey) return;
    setSelected(new Set(pickInitialSeries(data.numericColumns, data.timeColumn)));
    setInitializedKey(sig);
  }, [data, initializedKey]);

  const groups = useMemo(
    () => (data ? groupColumns(data.numericColumns, data.timeColumn) : []),
    [data]
  );

  useEffect(() => {
    const host = plotRef.current;
    if (!host) return;
    if (!data || !data.timeColumn || data.rows.length === 0 || selected.size === 0) {
      Plotly.purge(host);
      return;
    }
    const iTime = data.columns.indexOf(data.timeColumn);
    if (iTime < 0) {
      Plotly.purge(host);
      return;
    }
    // Convert time to seconds, t0-relative.
    const scale = data.timeScaleToSeconds || 1;
    const t0Raw = Number(data.rows[0][iTime]);
    const xs: number[] = new Array(data.rows.length);
    for (let i = 0; i < data.rows.length; i++) {
      const v = data.rows[i][iTime];
      xs[i] = (typeof v === 'number' ? v - t0Raw : Number(v) - t0Raw) * scale;
    }
    const traces: Partial<Plotly.PlotData>[] = [];
    for (const col of selected) {
      const idx = data.columns.indexOf(col);
      if (idx < 0) continue;
      const ys: number[] = new Array(data.rows.length);
      for (let i = 0; i < data.rows.length; i++) {
        const v = data.rows[i][idx];
        ys[i] = typeof v === 'number' ? v : Number(v);
      }
      traces.push({
        x: xs,
        y: ys,
        name: col,
        type: 'scattergl',
        mode: 'lines',
        line: { width: 1 },
      });
    }

    const shapes: Partial<Plotly.Shape>[] = [];
    const annotations: Partial<Plotly.Annotations>[] = [];
    if (showEvents) {
      for (const ev of data.events) {
        shapes.push({
          type: 'line',
          x0: ev.timeS,
          x1: ev.timeS,
          y0: 0,
          y1: 1,
          yref: 'paper',
          line: { color: ev.color, width: 1, dash: 'dash' },
        });
        annotations.push({
          x: ev.timeS,
          y: 1,
          yref: 'paper',
          text: ev.label,
          showarrow: false,
          textangle: '-90',
          xanchor: 'left',
          yanchor: 'top',
          font: { color: ev.color, size: 9 },
        });
      }
    }

    const xrange: [number, number] | undefined =
      trimToFlight && data.flightWindowS
        ? [data.flightWindowS.startS, data.flightWindowS.endS]
        : undefined;

    const layout: Partial<Plotly.Layout> = {
      paper_bgcolor: '#1e1e1e',
      plot_bgcolor: '#1e1e1e',
      font: { color: '#e6e6e6' },
      margin: { l: 60, r: 20, t: 40, b: 40 },
      xaxis: {
        title: { text: 'Time (s)' },
        gridcolor: '#333',
        range: xrange,
        autorange: xrange ? false : true,
      },
      yaxis: { gridcolor: '#333' },
      legend: { orientation: 'h', y: -0.15 },
      shapes,
      annotations,
      uirevision: 'plot2d',
      hovermode: 'x unified',
    };
    Plotly.react(host, traces, layout, { responsive: true, displaylogo: false });
  }, [data, selected, showEvents, trimToFlight]);

  useEffect(() => {
    const host = plotRef.current;
    return () => {
      if (host) Plotly.purge(host);
    };
  }, []);

  if (!data) return <div className="placeholder">Loading…</div>;
  if (!data.isTelemetry)
    return (
      <div className="placeholder">
        This file looks like a text log, not parsed telemetry — see the Raw Data tab.
      </div>
    );
  if (data.rows.length === 0)
    return <div className="placeholder">No data rows in this file.</div>;

  function toggle(col: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  }

  return (
    <div className="plot-pane">
      <div className="series-list">
        <div className="series-controls">
          <label className="series-item">
            <input
              type="checkbox"
              checked={trimToFlight}
              onChange={(e) => setTrimToFlight(e.target.checked)}
              disabled={!data.flightWindowS}
            />
            Trim to flight window
          </label>
          <label className="series-item">
            <input
              type="checkbox"
              checked={showEvents}
              onChange={(e) => setShowEvents(e.target.checked)}
              disabled={data.events.length === 0}
            />
            Show events ({data.events.length})
          </label>
        </div>
        <div className="series-scroll">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="group-header">{g.label}</div>
              {g.cols.map((c) => (
                <label className="series-item" key={c}>
                  <input
                    type="checkbox"
                    checked={selected.has(c)}
                    onChange={() => toggle(c)}
                  />
                  {c}
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="plot-host" ref={plotRef} />
    </div>
  );
}
