/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { fromRows, Spreadsheet } from '@datalayer/cells';
import {
  AppearanceControls,
  createThemeStore,
  DatalayerThemeProvider,
  themeConfigs,
} from '@datalayer/primer-addons';
import { Frame } from '../shared';

const DATA = fromRows([
  ['Theme', 'Mode', 'Score'],
  ['auto', 'from the page', 0.92],
  ['loop', 'primer-addons', 0.88],
  ['datalayer', 'primer-addons', 0.95],
]);

/** Primer variables a host page sets: what `theme="auto"` reads. */
const HOST: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--bgColor-default': '#fffdf5',
    '--fgColor-default': '#24292f',
    '--borderColor-muted': '#e8dcc0',
    '--bgColor-muted': '#fbf3dd',
  },
  dark: {
    '--bgColor-default': '#0d1117',
    '--fgColor-default': '#e6edf3',
    '--borderColor-muted': '#30363d',
    '--bgColor-muted': '#161b22',
  },
};

/**
 * The examples' appearance, primer-addons' theme store: the Datalayer theme
 * in the system's light or dark at first, then what the reader chose, kept
 * in this browser across reloads.
 */
const useAppearance = createThemeStore('cells-examples-theme', {
  colorMode: 'auto',
  theme: 'datalayer',
});

/** The colour mode `auto` stands for, here: the system's. */
const systemMode = (): 'light' | 'dark' =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

/**
 * primer-addons' appearance chooser (colour mode and theme) drives two grids:
 * one in the chosen primer-addons theme (`theme="loop"`, …), loaded on demand,
 * and one with `theme="auto"`, reading the Primer variables its host sets for
 * the mode. Under forced colours (Windows High Contrast) the system colours win.
 */
export default function Theming() {
  const { colorMode, theme: variant, setColorMode, setTheme } = useAppearance();
  const config = themeConfigs[variant];
  const mode = colorMode === 'auto' ? systemMode() : colorMode;
  return (
    <DatalayerThemeProvider
      colorMode={colorMode}
      theme={config.primerTheme}
      themeStyles={config.themeStyles}
    >
      <div style={{ maxWidth: 420 }}>
        <AppearanceControls
          colorMode={colorMode}
          themeVariant={variant}
          onColorModeChange={setColorMode}
          onThemeChange={(v) => setTheme(v, false)}
        />
      </div>
      <h3>{config.label}, from primer-addons</h3>
      <Frame height={200}>
        <Spreadsheet
          key={variant}
          defaultData={DATA}
          theme={variant}
          colorMode={colorMode}
          aria-label="Themed grid"
        />
      </Frame>
      <h3>auto, from the page’s Primer variables</h3>
      <div data-color-mode={mode} style={HOST[mode] as React.CSSProperties}>
        <Frame height={200}>
          <Spreadsheet defaultData={DATA} theme="auto" colorMode={mode} aria-label="Page grid" />
        </Frame>
      </div>
    </DatalayerThemeProvider>
  );
}
