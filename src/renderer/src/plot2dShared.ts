import type { StandardColumnMapping } from './importTypes';
import type { TimeAxis } from './telemetry/time';

export const HOVER_DASHBOARD_IDLE_TEXT = 'Hover over the chart to inspect values.';

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
    const values = event.points
      .map((point) => `${point.data.name ?? 'series'}: ${point.y.toFixed(3)}`)
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
