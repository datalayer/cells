/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The theme the renderer reads: resolved colours, not CSS variables (a
 * canvas cannot read `var(--…)`). The React layer resolves it from the
 * host's Primer variables or a primer-addons variant (react/theme).
 *
 * @module render/theme
 */

export interface CellsTheme {
  readonly background: string;
  readonly text: string;
  readonly textMuted: string;
  readonly gridline: string;
  readonly headerBackground: string;
  readonly headerText: string;
  readonly headerBorder: string;
  readonly headerSelectedBackground: string;
  /** Drawn over the selected cells at half opacity. */
  readonly selectionFill: string;
  readonly selectionBorder: string;
  readonly activeCellBorder: string;
  readonly fillHandle: string;
  readonly copyMarch: string;
  readonly frozenLine: string;
  readonly errorText: string;
  readonly linkText: string;
  readonly referenceColors: readonly string[];
  readonly remoteUserColors: readonly string[];
  readonly fontFamily: string;
  /** CSS px. */
  readonly fontSize: number;
  readonly headerFontSize: number;
  /** Charts (§3.12): the series colours in order, and the chart's axis, gridline, text and background. */
  readonly chartColors: readonly string[];
  readonly chartAxis: string;
  readonly chartGridline: string;
  readonly chartText: string;
  readonly chartBackground: string;
  /** Under `forced-colors: active`: the selection is an outline, never a fill. */
  readonly forcedColors?: boolean;
}

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const REFERENCES = ['#0969da', '#cf222e', '#1a7f37', '#8250df', '#bf8700', '#bc4c00', '#1b7c83'];

/** Primer's light defaults: what `auto` falls back to with no Primer host. */
export const LIGHT_THEME: CellsTheme = {
  background: '#ffffff',
  text: '#1f2328',
  textMuted: '#59636e',
  gridline: '#d1d9e0',
  headerBackground: '#f6f8fa',
  headerText: '#59636e',
  headerBorder: '#d1d9e0',
  headerSelectedBackground: '#ddf4ff',
  selectionFill: '#b6e3ff',
  selectionBorder: '#0969da',
  activeCellBorder: '#0969da',
  fillHandle: '#0969da',
  copyMarch: '#0969da',
  frozenLine: '#818b98',
  errorText: '#d1242f',
  linkText: '#0969da',
  referenceColors: REFERENCES,
  remoteUserColors: ['#bf3989', '#1a7f37', '#bc4c00', '#8250df'],
  fontFamily: FONT,
  fontSize: 13,
  headerFontSize: 12,
  // Primer's data-visualisation emphasis colours, light.
  chartColors: [
    '#0969da',
    '#1a7f37',
    '#bc4c00',
    '#8250df',
    '#bf8700',
    '#cf222e',
    '#bf3989',
    '#1b7c83',
  ],
  chartAxis: '#59636e',
  chartGridline: '#d1d9e0',
  chartText: '#1f2328',
  chartBackground: '#ffffff',
};

/** Primer's dark defaults. */
export const DARK_THEME: CellsTheme = {
  ...LIGHT_THEME,
  background: '#0d1117',
  text: '#f0f6fc',
  textMuted: '#9198a1',
  gridline: '#3d444d',
  headerBackground: '#151b23',
  headerText: '#9198a1',
  headerBorder: '#3d444d',
  headerSelectedBackground: '#0c2d6b',
  selectionFill: '#1f6feb',
  selectionBorder: '#4493f8',
  activeCellBorder: '#4493f8',
  fillHandle: '#4493f8',
  copyMarch: '#4493f8',
  frozenLine: '#656c76',
  errorText: '#f85149',
  linkText: '#4493f8',
  referenceColors: ['#4493f8', '#f85149', '#3fb950', '#ab7df8', '#d29922', '#db6d28', '#39c5cf'],
  remoteUserColors: ['#db61a2', '#3fb950', '#db6d28', '#ab7df8'],
  chartColors: [
    '#4493f8',
    '#3fb950',
    '#db6d28',
    '#ab7df8',
    '#d29922',
    '#f85149',
    '#db61a2',
    '#39c5cf',
  ],
  chartAxis: '#9198a1',
  chartGridline: '#3d444d',
  chartText: '#f0f6fc',
  chartBackground: '#0d1117',
};

/** Under forced colours: system colours, and outlines rather than fills. */
export const FORCED_COLORS_THEME: CellsTheme = {
  ...LIGHT_THEME,
  background: 'Canvas',
  text: 'CanvasText',
  textMuted: 'GrayText',
  gridline: 'GrayText',
  headerBackground: 'Canvas',
  headerText: 'CanvasText',
  headerBorder: 'CanvasText',
  headerSelectedBackground: 'Highlight',
  selectionFill: 'transparent',
  selectionBorder: 'Highlight',
  activeCellBorder: 'Highlight',
  fillHandle: 'Highlight',
  copyMarch: 'Highlight',
  frozenLine: 'CanvasText',
  errorText: 'CanvasText',
  linkText: 'LinkText',
  referenceColors: ['Highlight'],
  remoteUserColors: ['Highlight'],
  // Series are told apart by ECharts' decal patterns, not by colour (§3.12).
  chartColors: ['CanvasText', 'Highlight', 'LinkText', 'GrayText'],
  chartAxis: 'CanvasText',
  chartGridline: 'GrayText',
  chartText: 'CanvasText',
  chartBackground: 'Canvas',
  forcedColors: true,
};

const KEYS = Object.keys(LIGHT_THEME) as (keyof CellsTheme)[];

/** Throws a sentence naming the first missing or wrong field. */
export function checkTheme(theme: unknown): asserts theme is CellsTheme {
  if (typeof theme !== 'object' || theme === null) throw new Error('A CellsTheme is an object.');
  const t = theme as Record<string, unknown>;
  for (const key of KEYS) {
    const v = t[key];
    if (key === 'referenceColors' || key === 'remoteUserColors' || key === 'chartColors') {
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
        throw new Error(`CellsTheme.${key}: a non-empty list of colours.`);
      }
    } else if (key === 'fontSize' || key === 'headerFontSize') {
      if (!(typeof v === 'number' && v > 0))
        throw new Error(`CellsTheme.${key}: a positive size in px.`);
    } else if (typeof v !== 'string' || v === '') {
      throw new Error(`CellsTheme.${key}: a colour (or, for fontFamily, a font list).`);
    }
  }
}
