/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The end-to-end tests' page: two independent grids, under Strict Mode, one
 * of which can be unmounted and mounted again on the same model. Not linked
 * from the examples' menu.
 */

import { createCellsModel, fromRows, Spreadsheet } from '@datalayer/cells';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

const rows = Array.from({ length: 12 }, (_, r) =>
  Array.from({ length: 6 }, (_, c) => `${'ABCDEF'[c]}${r + 1}`),
);
const left = createCellsModel({ data: fromRows(rows) });
const right = createCellsModel({
  data: fromRows([
    ['right', 1],
    ['grid', 2],
  ]),
});
const budget = createCellsModel({ limits: { rows: 100, cols: 26 } });
(window as unknown as { cells: unknown }).cells = { left, right, budget };

function Page() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <h1>Cells test page</h1>
      <button onClick={() => setShown((s) => !s)}>
        {shown ? 'Unmount' : 'Mount'} the left grid
      </button>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ height: 300, position: 'relative' }}>
          {shown && <Spreadsheet model={left} aria-label="Left grid" />}
        </div>
        <div style={{ height: 300, position: 'relative' }}>
          <Spreadsheet model={right} aria-label="Right grid" />
        </div>
      </div>
      <div style={{ height: 240, position: 'relative', marginTop: 16 }}>
        <Spreadsheet model={budget} aria-label="Budget" />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
