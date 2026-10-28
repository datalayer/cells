/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  CellsProvider,
  createCellsModel,
  Spreadsheet,
  toA1,
  useCell,
  useCellsEditor,
  useCellsModel,
  useCommand,
  useHistory,
  useSelection,
} from '@datalayer/cells';
import { useState } from 'react';
import { Frame, Soon } from '../shared';
import { Button } from '@primer/react';

/**
 * A formula bar: a plain input bound to the edit buffer the in-cell editor
 * shares (`useCellsEditor`). The Primer formula bar of the chrome comes in C7-04.
 */
function FormulaBar() {
  const selection = useSelection();
  const editor = useCellsEditor();
  const { content } = useCell(toA1(selection.active));
  const shown =
    editor.edit !== null
      ? editor.edit.text
      : content?.formula !== undefined
        ? `=${content.formula}`
        : content?.value === null || content === null
          ? ''
          : String(typeof content.value === 'object' ? content.value.error : content.value);
  return (
    <p className="bar">
      <strong>{toA1(selection.active)}</strong>{' '}
      <input
        aria-label="Formula bar"
        value={shown}
        onFocus={() => editor.edit === null && editor.start()}
        onChange={(e) =>
          editor.edit === null
            ? editor.start(undefined, e.target.value)
            : editor.setText(e.target.value)
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && editor.edit !== null) {
            e.preventDefault();
            editor.commit();
          } else if (e.key === 'Escape') editor.cancel();
        }}
      />
    </p>
  );
}

function Actions() {
  const selection = useSelection();
  const insert = useCommand('INSERT_AXIS');
  const remove = useCommand('DELETE_AXIS');
  const history = useHistory();
  const [message, setMessage] = useState('');
  const run = (result: { ok: boolean; refusals?: readonly { message: string }[] }) =>
    setMessage(result.ok ? '' : (result.refusals?.[0]?.message ?? ''));
  return (
    <p>
      <Button
        size="small"
        onClick={() =>
          run(insert({ sheet: selection.sheet, axis: 'rows', at: selection.active.row, n: 1 }))
        }
      >
        Insert row above
      </Button>
      <Button
        size="small"
        onClick={() =>
          run(remove({ sheet: selection.sheet, axis: 'rows', at: selection.active.row, n: 1 }))
        }
      >
        Delete row
      </Button>
      <Button size="small" disabled={!history.canUndo} onClick={() => history.undo()}>
        Undo {history.undoLabel ?? ''}
      </Button>
      <Button size="small" disabled={!history.canRedo} onClick={() => history.redo()}>
        Redo {history.redoLabel ?? ''}
      </Button>
      {message && <span role="alert"> {message}</span>}
    </p>
  );
}

/**
 * Type into the grid: typing replaces a cell, F2 edits it, Enter and Tab
 * commit and move (Shift goes back), Escape cancels, Alt+Enter is a new line,
 * Delete clears the selection, Ctrl+Z undoes.
 */
export default function Editing() {
  const model = useCellsModel(() => createCellsModel({ limits: { rows: 1000, cols: 26 } }));
  return (
    <CellsProvider model={model}>
      <Soon milestone="C3-02 to C3-05">
        Inserting and resizing from the grid, number formats, the system clipboard, the fill handle
        and sort.
      </Soon>
      <FormulaBar />
      <Actions />
      <Frame>
        <Spreadsheet model={model} aria-label="Editing" />
      </Frame>
    </CellsProvider>
  );
}
