import Plotly3D from 'plotly.js-gl3d-dist-min';
import type { GpsEventMarker, GpsMapPoint } from './gpsMapShared';
import { getPlotTheme } from './plotTheme';
import { axisRange } from './telemetry/core';
import {
  convertDisplayValue,
  displayUnitFor,
  type ColumnUnit,
  type DisplayUnitSystem
} from '../../shared/units';

type PlotlyTrace = Record<string, unknown>;

export type Plot3dAspectRatio = {
  x: number;
  y: number;
  z: number;
};

export type Gps3dTrack = {
  label: string;
  color: [number, number, number, number];
  points: GpsMapPoint[];
};

function rgbaString(color: [number, number, number, number], alphaScale = 1) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.min(1, (color[3] / 255) * alphaScale)})`;
}

const LENGTH_METERS: ColumnUnit = { family: 'length', unit: 'm' };

export function computeGpsPlot3dAspectRatio(points: GpsMapPoint[]): Plot3dAspectRatio {
  if (points.length === 0) return { x: 1, y: 1, z: 1 };

  const lonRange = axisRange(points.map((point) => point.longitude));
  const latRange = axisRange(points.map((point) => point.latitude));
  const horizontalRange = Math.max(lonRange, latRange, 1e-9);

  return {
    x: Math.max(lonRange / horizontalRange, 1e-6),
    y: Math.max(latRange / horizontalRange, 1e-6),
    z: 1
  };
}

export function buildSingleGpsPlot3dTraces(
  points: GpsMapPoint[],
  eventMarkers: GpsEventMarker[],
  displayUnits: DisplayUnitSystem
): PlotlyTrace[] {
  const zUnit = displayUnitFor(LENGTH_METERS, displayUnits).unit;

  return [
    {
      type: 'scatter3d',
      mode: 'lines+markers',
      x: points.map((point) => point.longitude),
      y: points.map((point) => point.latitude),
      z: points.map((point) => convertDisplayValue(point.altitude, LENGTH_METERS, displayUnits)),
      text: points.map((point) => `t=${point.time.toFixed(2)}s`),
      hovertemplate:
        `Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Alt: %{z:.2f} ${zUnit}<br>%{text}<extra></extra>`,
      line: {
        width: 4,
        color: points.map((point) => point.time),
        colorscale: 'Turbo'
      },
      marker: {
        size: 3,
        color: points.map((point) => point.time),
        colorscale: 'Turbo',
        showscale: true,
        colorbar: { title: 'Time (s)' }
      }
    },
    {
      type: 'scatter3d',
      mode: 'markers+text',
      x: eventMarkers.map((point) => point.longitude),
      y: eventMarkers.map((point) => point.latitude),
      z: eventMarkers.map((point) => convertDisplayValue(point.altitude, LENGTH_METERS, displayUnits)),
      text: eventMarkers.map((point) => point.label),
      textposition: 'top center',
      hovertemplate:
        `%{text}<br>Source: %{customdata}<br>Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Alt: %{z:.2f} ${zUnit}<br>Time: %{meta:.2f} s<extra></extra>`,
      customdata: eventMarkers.map((point) => point.sourceLabel),
      meta: eventMarkers.map((point) => point.time),
      marker: {
        size: 5,
        color: eventMarkers.map((point) => rgbaString(point.color)),
        line: {
          color: '#ffffff',
          width: 1
        }
      }
    }
  ];
}

export function buildCompareGpsPlot3dTraces(
  tracks: Gps3dTrack[],
  displayUnits: DisplayUnitSystem
): PlotlyTrace[] {
  const zUnit = displayUnitFor(LENGTH_METERS, displayUnits).unit;

  return tracks.map((track) => ({
    type: 'scatter3d',
    mode: 'lines',
    x: track.points.map((point) => point.longitude),
    y: track.points.map((point) => point.latitude),
    z: track.points.map((point) => convertDisplayValue(point.height, LENGTH_METERS, displayUnits)),
    text: track.points.map((point) => `t=${point.time.toFixed(2)}s`),
    name: track.label,
    hovertemplate:
      `Lon: %{x:.6f}<br>Lat: %{y:.6f}<br>Height: %{z:.2f} ${zUnit}<br>%{text}<extra>%{fullData.name}</extra>`,
    line: { width: 4, color: rgbaString(track.color) }
  }));
}

export function renderGpsPlot3d(
  plotElement: HTMLElement,
  traces: PlotlyTrace[],
  aspectRatio: Plot3dAspectRatio,
  zAxisTitle: string
) {
  const theme = getPlotTheme();

  return Plotly3D.newPlot(
    plotElement,
    traces,
    {
      autosize: true,
      paper_bgcolor: theme.paperBg,
      font: { color: theme.textColor },
      margin: { t: 24, r: 24, b: 24, l: 24 },
      scene: {
        aspectmode: 'manual',
        aspectratio: aspectRatio,
        xaxis: { title: 'Longitude', gridcolor: theme.gridColor },
        yaxis: { title: 'Latitude', gridcolor: theme.gridColor },
        zaxis: { title: zAxisTitle, gridcolor: theme.gridColor },
        bgcolor: theme.plotBg
      }
    },
    {
      responsive: true,
      displaylogo: false,
      scrollZoom: true
    }
  ).then(() => {
    Plotly3D.Plots.resize(plotElement);
  });
}

export function purgeGpsPlot3d(plotElement: HTMLElement) {
  Plotly3D.purge(plotElement);
}
