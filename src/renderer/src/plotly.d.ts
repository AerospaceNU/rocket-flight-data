declare module 'plotly.js-dist-min' {
  type PlotlyConfig = Record<string, unknown>;
  type PlotlyLayout = Record<string, unknown>;
  type PlotlyTrace = Record<string, unknown>;

  const Plotly: {
    newPlot: (
      element: HTMLElement,
      data: PlotlyTrace[],
      layout?: PlotlyLayout,
      config?: PlotlyConfig
    ) => Promise<void>;
    purge: (element: HTMLElement) => void;
    Plots: {
      resize: (element: HTMLElement) => void;
    };
  };

  export default Plotly;
}
