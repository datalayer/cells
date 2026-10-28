/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { type CellsModel, type CellValue, createCellsModel, Spreadsheet } from '@datalayer/cells';
import { useState } from 'react';
import { Frame } from '../shared';
import { Button } from '@primer/react';

/** Ten columns of numbers and a column of labels down a million rows, loaded as a file is: no undo step. */
export function loadMillion(): { model: CellsModel; ms: number } {
  const t0 = performance.now();
  const model = createCellsModel();
  const n = 1_000_000;
  const columns: CellValue[][] = Array.from({ length: 10 }, (_, col) =>
    Array.from({ length: n }, (_, r) => r * 0.5 + col),
  );
  columns.push(Array.from({ length: n }, (_, r) => `Row ${r + 1} of a million`));
  model.loadColumns('s1', { row: 0, col: 0 }, columns);
  return { model, ms: performance.now() - t0 };
}

/**
 * A million rows drawn on canvas: only what shows is painted, a small scroll
 * copies the pixels it has. Ctrl+End jumps to the last row. Open the page with
 * ?debug=cells for the frame counters.
 */
export default function Large() {
  const [loaded, setLoaded] = useState<{ model: CellsModel; ms: number } | null>(null);
  const debug = new URLSearchParams(window.location.search).get('debug') === 'cells';
  return loaded === null ? (
    <p>
      <Button size="small" onClick={() => setLoaded(loadMillion())}>
        Load 11 columns × 1,000,000 rows
      </Button>
    </p>
  ) : (
    <>
      <p>
        {(11_000_000).toLocaleString()} cells loaded in {Math.round(loaded.ms)} ms.{' '}
        {debug ? (
          'The counters are at the bottom right.'
        ) : (
          <a href="?debug=cells#/large">Show the frame counters</a>
        )}
      </p>
      <Frame height={560}>
        <Spreadsheet model={loaded.model} aria-label="A million rows" debug={debug} />
      </Frame>
    </>
  );
}
