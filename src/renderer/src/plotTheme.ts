export type PlotTheme = {
  paperBg: string;
  plotBg: string;
  textColor: string;
  gridColor: string;
  spikeColor: string;
};

const DARK_PLOT_THEME: PlotTheme = {
  paperBg: 'rgba(0,0,0,0)',
  plotBg: 'rgba(0,0,0,0)',
  textColor: '#e4e7eb',
  gridColor: '#30343a',
  spikeColor: '#aab2bd'
};

function cssVariable(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function getPlotTheme(): PlotTheme {
  const theme = document.documentElement.getAttribute('data-theme');

  if (theme !== 'slate-light') {
    return DARK_PLOT_THEME;
  }

  return {
    paperBg: 'rgba(0,0,0,0)',
    plotBg: 'rgba(0,0,0,0)',
    textColor: cssVariable('--text-primary', '#1f2a36'),
    gridColor: cssVariable('--border', '#b7c4d1'),
    spikeColor: cssVariable('--text-muted', '#556678')
  };
}
