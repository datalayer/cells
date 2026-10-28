/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { CellsProvider, createCellsModel, Spreadsheet, useCellsModel } from '@datalayer/cells';
import { FormulaBar, SheetTabs, Toolbar } from '@datalayer/cells/chrome';
import { DatalayerThemeProvider, themeConfigs } from '@datalayer/primer-addons';
import { Frame } from '../shared';

/**
 * `@datalayer/cells/chrome` around a grid: the toolbar (the commands plugins
 * contribute to `datalayer.cells.toolbarItem`), the formula bar with its name
 * box, and the sheet tabs, all reading the grid's model through
 * `<CellsProvider>`. Tab to the toolbar and move with the arrows; type a
 * reference in the name box; double-click a tab to rename it.
 */
export default function Chrome() {
  const model = useCellsModel(() => {
    const m = createCellsModel({ limits: { rows: 200, cols: 12 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [
        ['Item', 'Amount', 'Share'],
        ['Rent', 1200, { formula: 'B2/B$5' }],
        ['Food', 450.5, { formula: 'B3/B$5' }],
        ['Transport', 349.5, { formula: 'B4/B$5' }],
        ['Total', { formula: 'SUM(B2:B4)' }, { formula: 'SUM(C2:C4)' }],
      ],
    });
    m.dispatch({ type: 'RENAME_SHEET', sheet: 's1', name: 'Budget' });
    return m;
  });
  const config = themeConfigs.datalayer;
  return (
    <DatalayerThemeProvider
      colorMode="auto"
      theme={config.primerTheme}
      themeStyles={config.themeStyles}
    >
      <CellsProvider model={model}>
        <Toolbar />
        <FormulaBar />
        <Frame height={260}>
          <Spreadsheet model={model} aria-label="Budget" />
        </Frame>
        <SheetTabs />
      </CellsProvider>
    </DatalayerThemeProvider>
  );
}
