import type { ThemeId } from './importTypes';

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

const LIGHT_PLOT_THEME: PlotTheme = {
  paperBg: 'rgba(0,0,0,0)',
  plotBg: 'rgba(0,0,0,0)',
  textColor: '#1f2a36',
  gridColor: '#b7c4d1',
  spikeColor: '#556678'
};

const PLOT_THEMES: Record<ThemeId, PlotTheme> = {
  'default-dark': DARK_PLOT_THEME,
  'slate-light': LIGHT_PLOT_THEME,
  'forest-dark': DARK_PLOT_THEME,
  'amber-dark': DARK_PLOT_THEME
};

export function getPlotTheme(themeId?: ThemeId | string | null): PlotTheme {
  const theme = themeId ?? document.documentElement.getAttribute('data-theme');
  return PLOT_THEMES[theme as ThemeId] ?? DARK_PLOT_THEME;
}
