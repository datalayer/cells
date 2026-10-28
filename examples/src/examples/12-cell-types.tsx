/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  CellsProvider,
  createCellsModel,
  Spreadsheet,
  useCellsModel,
  useRange,
} from '@datalayer/cells';
import { Frame } from '../shared';

/**
 * The built-in cell types, each a contribution to `datalayer.cells.cellType`
 * from `CellsCellTypesPlugin`: a cell takes one through its style
 * (`{ type: 'checkbox' }`), so a type applies per cell, row or column.
 * Space or a click toggles a checkbox; Enter or a click opens a link; a
 * progress bar shows the fraction typed into the cell.
 */
function Summary() {
  const [[done, tasks]] = useRange('F1:G1');
  return (
    <p>
      {String(done)} of {String(tasks)} tasks done, as <code>=COUNTIF(A2:A7, TRUE)</code> and{' '}
      <code>=COUNTA(B2:B7)</code> read the typed cells; the progress column averages to{' '}
      <code>=AVERAGE(D2:D7)</code>.
    </p>
  );
}

export default function CellTypes() {
  const model = useCellsModel(() => {
    const m = createCellsModel({ limits: { rows: 100, cols: 10 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [
        [
          'Done',
          'Task',
          'Where',
          'Progress',
          null,
          { formula: 'COUNTIF(A2:A7, TRUE)' },
          { formula: 'COUNTA(B2:B7)' },
        ],
        [true, 'Write the plan', 'https://datalayer.ai', 1],
        [true, 'Build the model', 'https://github.com/datalayer/cells', 1],
        [false, 'Draw the grid', 'cells.datalayer.tech', 0.8],
        [false, 'Ship the chrome', 'mailto:hello@datalayer.io', 0.35],
        [false, 'Release 1.0', 'not a link', 0],
        [{ formula: 'D7=1' }, 'Average progress', null, { formula: 'AVERAGE(D2:D6)' }],
      ],
    });
    const column = (col: number, type: string) =>
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 1, left: col, bottom: 6, right: col },
        style: { type },
      });
    column(0, 'checkbox');
    column(2, 'link');
    column(3, 'progress');
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 0, left: 0, bottom: 0, right: 3 },
      style: { bold: true },
    });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 0, to: 0, size: 60 });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 1, to: 1, size: 160 });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 2, to: 2, size: 220 });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 3, to: 3, size: 140 });
    m.select({
      sheet: 's1',
      zones: [{ top: 1, left: 0, bottom: 1, right: 0 }],
      anchor: { row: 1, col: 0 },
      active: { row: 1, col: 0 },
    });
    return m;
  });
  return (
    <CellsProvider model={model}>
      <p>
        Column A is a <strong>checkbox</strong> (Space or a click toggles it), column C a{' '}
        <strong>link</strong> (Enter or a click opens it in a new tab), column D a{' '}
        <strong>progress</strong> bar (type a fraction, <code>0.8</code>). A type is a style
        property, <code>{'{ type: "checkbox" }'}</code>, set with <code>SET_STYLE</code>; a screen
        reader hears "checked", "…, link" and "80 percent".
      </p>
      <Frame height={220}>
        <Spreadsheet model={model} aria-label="Tasks" />
      </Frame>
      <Summary />
    </CellsProvider>
  );
}
