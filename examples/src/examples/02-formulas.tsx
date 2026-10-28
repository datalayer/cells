/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { createCellsModel, Spreadsheet, useCellsModel } from '@datalayer/cells';
import { Frame } from '../shared';

/** Formulas evaluate on read and recalculate on every change; change a or b and the rest follows. */
export default function Formulas() {
  const model = useCellsModel(() =>
    createCellsModel({
      data: {
        version: 1,
        sheets: [
          {
            id: 's1',
            name: 'Sheet1',
            rows: {
              '0': { cells: { '0': { v: 'a' }, '1': { v: 'b' }, '2': { v: 'a × b' } } },
              '1': { cells: { '0': { v: 6 }, '1': { v: 7 }, '2': { f: 'A2*B2' } } },
              '2': { cells: { '0': { v: 4 }, '1': { v: 2.5 }, '2': { f: 'A3*B3' } } },
              '3': { cells: { '0': { v: 9 }, '1': { v: -1 }, '2': { f: 'A4*B4' } } },
              '4': {
                cells: {
                  '0': { v: 'Total' },
                  '1': { f: 'IF(SUM(C2:C4)>50,"over","under")' },
                  '2': { f: 'SUM(C2:C4)' },
                },
              },
            },
          },
        ],
      },
    }),
  );
  return (
    <>
      <Frame height={200}>
        <Spreadsheet model={model} aria-label="Formulas" />
      </Frame>
    </>
  );
}
