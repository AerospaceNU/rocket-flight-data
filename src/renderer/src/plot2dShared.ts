import type { StandardColumnMapping } from './importTypes';
import type { TimeAxis } from './telemetry/time';
import { getPlotTheme } from './plotTheme';

export const HOVER_DASHBOARD_IDLE_TEXT = 'Hover over the chart to inspect values.';
export const PLOTLY_INTERACTION_CONFIG = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true
};

type PlotEvent = {
  label: string;
  time: number;
  color: string;
};

type PlotHoverPoint = {
  curveNumber?: number;
  x: number | string;
  y: number;
  data: {
    meta?: unknown;
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

export function defaultSeriesIndexes(
  headers: string[],
  timeColumnIndex: number | null,
  standardColumns: StandardColumnMapping | null
) {
  const preferred = standardColumns
    ? [
        standardColumns.altitudeMeters?.column,
        standardColumns.velocityMetersPerSecond?.column,
        standardColumns.accelerationMetersPerSecondSquared?.column
      ].filter((column): column is string => Boolean(column))
    : [];
  const indexes = preferred
    .map((name) => headers.indexOf(name))
    .filter((index) => index > 0 && index !== timeColumnIndex);

  return indexes.length > 0
    ? indexes
    : headers
        .map((_, index) => index)
        .filter((index) => index > 0 && index !== timeColumnIndex)
        .slice(0, 3);
}

export function attachPlotHoverDashboard(
  plotElement: HTMLElement,
  xAxis: Pick<TimeAxis, 'hoverLabel'>,
  setHoverText: (text: string) => void
) {
  const interactivePlot = plotElement as PlotElement;
  interactivePlot.removeAllListeners?.('plotly_hover');
  interactivePlot.removeAllListeners?.('plotly_unhover');
  interactivePlot.on?.('plotly_hover', (event) => {
    if (!event.points?.length) return;

    const hoveredX = event.points[0]?.x;
    const hoverValue = typeof hoveredX === 'number' ? hoveredX.toFixed(3) : hoveredX;
    const values = [...event.points]
      .sort((left, right) => (left.curveNumber ?? 0) - (right.curveNumber ?? 0))
      .map((point) => {
        const label = typeof point.data.meta === 'string' ? point.data.meta : point.data.name ?? 'series';
        return `${label}: ${point.y.toFixed(3)}`;
      })
      .join('   ');
    setHoverText(`${xAxis.hoverLabel}: ${hoverValue}${xAxis.hoverLabel === 'time' ? ' s' : ''}   ${values}`);
  });
  interactivePlot.on?.('plotly_unhover', () => {
    setHoverText(HOVER_DASHBOARD_IDLE_TEXT);
  });
}

export function computeEventLabelShifts(
  events: { label: string; time: number }[],
  xValues: number[]
) {
  const lastVisible = xValues[xValues.length - 1];
  const firstVisible = xValues[0];
  const visibleRange =
    typeof lastVisible === 'number' && typeof firstVisible === 'number' ? lastVisible - firstVisible : 0;
  const threshold = visibleRange > 0 ? Math.max(visibleRange * 0.022, 1e-6) : 0;
  const labelHeight = (label: string) => Math.max(54, label.length * 6.5 + 18);

  const indexed = events.map((event, index) => ({ event, index }));
  indexed.sort((left, right) => left.event.time - right.event.time);

  const shifts = new Array<number>(events.length).fill(0);
  let clusterEnd = Number.NEGATIVE_INFINITY;
  let nextShift = 0;

  for (const { event, index } of indexed) {
    if (event.time - clusterEnd > threshold) {
      nextShift = 0;
    }
    shifts[index] = -nextShift;
    nextShift += labelHeight(event.label);
    clusterEnd = event.time;
  }

  return shifts;
}

export function buildPlot2dLayout({
  events,
  eventLabelShifts,
  xAxisTitle,
  yAxisTitle,
  themeId
}: {
  events: PlotEvent[];
  eventLabelShifts: number[];
  xAxisTitle: string;
  yAxisTitle: string;
  themeId?: string;
}) {
  const theme = getPlotTheme(themeId);

  return {
    autosize: true,
    paper_bgcolor: theme.paperBg,
    plot_bgcolor: theme.plotBg,
    font: { color: theme.textColor },
    hoverlabel: { font: { color: theme.textColor } },
    margin: { t: 24, r: 24, b: 48, l: 64 },
    hovermode: 'x',
    shapes: events.map((event) => ({
      type: 'line',
      x0: event.time,
      x1: event.time,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: { color: event.color, width: 1, dash: 'dash' }
    })),
    annotations: events.map((event, index) => ({
      x: event.time,
      y: 1,
      yref: 'paper',
      yanchor: 'top',
      yshift: eventLabelShifts[index] ?? 0,
      text: event.label,
      showarrow: false,
      textangle: -90,
      xanchor: 'right',
      font: { color: event.color, size: 10 }
    })),
    xaxis: {
      title: { text: xAxisTitle, standoff: 12, font: { color: theme.textColor } },
      automargin: true,
      gridcolor: theme.gridColor,
      tickfont: { color: theme.textColor },
      showspikes: true,
      spikemode: 'across',
      spikesnap: 'cursor',
      spikedash: 'dash',
      spikecolor: theme.spikeColor,
      spikethickness: 1
    },
    yaxis: {
      title: { text: yAxisTitle, font: { color: theme.textColor } },
      gridcolor: theme.gridColor,
      tickfont: { color: theme.textColor }
    },
    legend: {
      font: { color: theme.textColor },
      orientation: 'h',
      yanchor: 'bottom',
      y: 1.02,
      xanchor: 'right',
      x: 1
    }
  };
}
