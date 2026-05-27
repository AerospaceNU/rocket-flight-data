import React, { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { FlightData } from '../shared/types';
import { findGpsPair } from './gps';

export function Plot3D({ data }: { data: FlightData | null }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    if (!data) {
      Plotly.purge(host);
      return;
    }
    const pair = findGpsPair(data.columns);
    if (!pair) {
      Plotly.purge(host);
      return;
    }
    const iLat = data.columns.indexOf(pair.lat);
    const iLon = data.columns.indexOf(pair.lon);
    const iAlt = pair.alt ? data.columns.indexOf(pair.alt) : -1;
    const lat: number[] = [];
    const lon: number[] = [];
    const alt: number[] = [];
    for (const row of data.rows) {
      const la = Number(row[iLat]);
      const lo = Number(row[iLon]);
      const al = iAlt >= 0 ? Number(row[iAlt]) : 0;
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      if (la === 0 && lo === 0) continue;
      lat.push(la);
      lon.push(lo);
      alt.push(Number.isFinite(al) ? al : 0);
    }
    if (lat.length < 2) {
      Plotly.purge(host);
      return;
    }
    const trace: Partial<Plotly.PlotData> = {
      x: lon,
      y: lat,
      z: alt,
      type: 'scatter3d',
      mode: 'lines+markers',
      line: { width: 3, color: '#4ec9b0' },
      marker: { size: 2, color: alt as unknown as Plotly.Color, colorscale: 'Viridis' },
      name: 'trajectory',
    };
    const layout: Partial<Plotly.Layout> = {
      paper_bgcolor: '#1e1e1e',
      plot_bgcolor: '#1e1e1e',
      font: { color: '#e6e6e6' },
      margin: { l: 0, r: 0, t: 20, b: 0 },
      scene: {
        xaxis: { title: { text: pair.lon }, gridcolor: '#333', color: '#e6e6e6' },
        yaxis: { title: { text: pair.lat }, gridcolor: '#333', color: '#e6e6e6' },
        zaxis: { title: { text: pair.alt ?? 'altitude' }, gridcolor: '#333', color: '#e6e6e6' },
        bgcolor: '#1e1e1e',
      },
    };
    Plotly.react(host, [trace], layout, { responsive: true, displaylogo: false });
  }, [data]);

  useEffect(() => {
    const host = ref.current;
    return () => {
      if (host) Plotly.purge(host);
    };
  }, []);

  if (!data) return <div className="placeholder">Loading…</div>;
  return <div className="plot-host" ref={ref} style={{ height: '100%' }} />;
}
