/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  createCellsModel,
  Spreadsheet,
  toA1,
  useCellsModel,
  useCommand,
  useSelection,
  CellsProvider,
} from '@datalayer/cells';
import { useState } from 'react';
import { Frame, Soon } from '../shared';

function Writer() {
  const set = useCommand('SET_CELLS');
  const selection = useSelection();
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        set({ sheet: selection.sheet, at: selection.active, cells: [[text]] });
        setText('');
      }}
    >
      <input
        aria-label={`Write into ${toA1(selection.active)}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  );
}

/** Two grids on one in-memory model: what they share today. Loro, across windows and people, is C6. */
export default function Collaboration() {
  const model = useCellsModel(() => createCellsModel({ limits: { rows: 1000, cols: 26 } }));
  return (
    <>
      <Soon milestone="C6">
        Two panes on one Loro document, over lexical-loro's websocket server, with presence and
        per-user undo. Here two grids share one model in one page, which is all that exists today;
        they share its selection too, which is view state of the model.
      </Soon>
      <CellsProvider model={model}>
        <Writer />
        <div className="panes">
          <Frame height={260}>
            <Spreadsheet model={model} aria-label="Left pane" />
          </Frame>
          <Frame height={260}>
            <Spreadsheet model={model} aria-label="Right pane" />
          </Frame>
        </div>
      </CellsProvider>
    </>
  );
}
