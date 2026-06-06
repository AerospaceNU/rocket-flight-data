export type PlotViewMode = 'plot2d' | 'plot3d';

export type PlotViewState = Record<string, unknown>;

type PlotElement = HTMLElement & {
  _fullLayout?: Record<string, unknown>;
  on?: (eventName: string, callback: () => void) => void;
  removeAllListeners?: (eventName: string) => void;
};

type PlotlyApi = {
  Plots?: {
    resize?: (plotElement: HTMLElement) => unknown;
  };
  redraw?: (plotElement: HTMLElement) => unknown;
  relayout?: (plotElement: HTMLElement, update: Record<string, unknown>) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePlain<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function axisViewState(axis: unknown) {
  if (!isRecord(axis)) return null;

  const range = axis.range;
  if (Array.isArray(range) && range.length >= 2) {
    return { range: clonePlain(range.slice(0, 2)), autorange: false };
  }

  if (axis.autorange === true) {
    return { autorange: true };
  }

  return null;
}

function mergeRecord(base: unknown, override: unknown): Record<string, unknown> {
  return {
    ...(isRecord(base) ? base : {}),
    ...(isRecord(override) ? override : {})
  };
}

export function capturePlotViewState(plotElement: HTMLElement, mode: PlotViewMode): PlotViewState | null {
  const layout = (plotElement as PlotElement)._fullLayout;
  if (!layout) return null;

  if (mode === 'plot2d') {
    const xaxis = axisViewState(layout.xaxis);
    const yaxis = axisViewState(layout.yaxis);
    if (!xaxis && !yaxis) return null;

    return {
      ...(xaxis ? { xaxis } : {}),
      ...(yaxis ? { yaxis } : {})
    };
  }

  if (!isRecord(layout.scene)) return null;

  const xaxis = axisViewState(layout.scene.xaxis);
  const yaxis = axisViewState(layout.scene.yaxis);
  const zaxis = axisViewState(layout.scene.zaxis);
  const camera = isRecord(layout.scene.camera) ? clonePlain(layout.scene.camera) : null;

  if (!camera && !xaxis && !yaxis && !zaxis) return null;

  return {
    scene: {
      ...(camera ? { camera } : {}),
      ...(xaxis ? { xaxis } : {}),
      ...(yaxis ? { yaxis } : {}),
      ...(zaxis ? { zaxis } : {})
    }
  };
}

export function saveCurrentPlotViewState(
  plotElement: HTMLElement,
  mode: PlotViewMode,
  saveViewState: (viewState: PlotViewState) => void
) {
  const viewState = capturePlotViewState(plotElement, mode);
  if (viewState) {
    saveViewState(viewState);
  }
}

export function attachPlotViewStateTracker(
  plotElement: HTMLElement,
  mode: PlotViewMode,
  saveViewState: (viewState: PlotViewState) => void
) {
  const interactivePlot = plotElement as PlotElement;
  interactivePlot.removeAllListeners?.('plotly_relayout');
  interactivePlot.on?.('plotly_relayout', () => {
    saveCurrentPlotViewState(plotElement, mode, saveViewState);
  });
}

export function applyPlotViewState<T extends Record<string, unknown>>(
  layout: T,
  viewState?: PlotViewState | null
): T {
  if (!viewState) return layout;

  const nextLayout: Record<string, unknown> = { ...layout };

  if (isRecord(viewState.xaxis)) {
    nextLayout.xaxis = mergeRecord(nextLayout.xaxis, viewState.xaxis);
  }

  if (isRecord(viewState.yaxis)) {
    nextLayout.yaxis = mergeRecord(nextLayout.yaxis, viewState.yaxis);
  }

  if (isRecord(viewState.scene)) {
    const scene = mergeRecord(nextLayout.scene, viewState.scene);

    for (const axisName of ['xaxis', 'yaxis', 'zaxis']) {
      if (isRecord(viewState.scene[axisName])) {
        scene[axisName] = mergeRecord(
          isRecord(nextLayout.scene) ? nextLayout.scene[axisName] : undefined,
          viewState.scene[axisName]
        );
      }
    }

    nextLayout.scene = scene;
  }

  return nextLayout as T;
}

export function schedulePlotRedraw(plotly: PlotlyApi, plotElement: HTMLElement) {
  let firstFrame = 0;
  let secondFrame = 0;

  firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      void plotly.relayout?.(plotElement, { autosize: true });
      void plotly.Plots?.resize?.(plotElement);
      void plotly.redraw?.(plotElement);
    });
  });

  return () => {
    cancelAnimationFrame(firstFrame);
    cancelAnimationFrame(secondFrame);
  };
}
