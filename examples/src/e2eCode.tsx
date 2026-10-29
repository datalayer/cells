/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The live workbook's test page: the page's grid bound to its collaboration
 * document as the Code cells page binds it, its code cells run on the local
 * Jupyter server's kernel (`make jupyter-server`, `datalayer_cells` in the
 * kernel's environment) over the `datalayer.cells` comm, and a second peer —
 * another model on another `LoroDoc` — kept in step with the page's document
 * both ways, shown in a second grid. What the kernel writes reaches the page
 * through the comm and the second peer through the document. Not linked from
 * the examples' menu.
 */

import {
  buildCellsReactor,
  CellsKernels,
  codeCell,
  codeRunner,
  createCellsModel,
  fromRows,
  Spreadsheet,
} from '@datalayer/cells';
import { LoroBinding } from '@datalayer/cells/collab';
import { contribution, definePlugin } from '@datalayer/reactor';
import { LoroDoc } from 'loro-crdt';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bindDocument, localKernel, type PageBinding } from './examples/13-code-cells';

const later: { binding?: PageBinding } = {};
const kernel = localKernel();
const reactor = buildCellsReactor([
  definePlugin({
    name: '@datalayer/cells-e2e-local-kernel',
    displayName: 'Kernel: Jupyter (local)',
    description: 'The local Jupyter server, bound to the page’s document.',
    contributes: [
      contribution(
        CellsKernels,
        { id: kernel.id, label: kernel.label, connect: () => localKernel(later.binding).connect() },
        { id: kernel.id },
      ),
    ],
  }),
]);

const model = createCellsModel({
  reactor,
  data: fromRows([
    ['Month', 'Units', 'Code', null, 'Taken'],
    ['Jan', 12],
    ['Feb', 15],
    ['Mar', 19],
    ['Apr', 24],
    ['May', 28],
    ['Jun', 31],
  ]),
});
// C2 writes F2 and sums the units; C4 spills a frame over E1, which holds a value; C6 spills into H1:I3, empty.
const CODE: Record<string, [number, number, string]> = {
  C2: [1, 2, 'cells["F2"] = 42\nsum(r[0] for r in cells["B2:B7"].values.tolist())'],
  C4: [
    3,
    2,
    'import pandas as pd\ncells["E1:F3"] = pd.DataFrame({"a": [1, 2], "b": [3, 4]})\n"spilled"',
  ],
  C6: [
    5,
    2,
    'import pandas as pd\ncells["H1:I3"] = pd.DataFrame({"a": [1, 2], "b": [3, 4]})\n"spilled"',
  ],
};
for (const [row, col, source] of Object.values(CODE))
  model.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row,
    col,
    code: codeCell(source, { frame: null }),
  });
later.binding = bindDocument(model);

// The second peer: its own model and document, every change of either document sent to the other.
const peer = createCellsModel({});
const peerDoc = new LoroDoc();
new LoroBinding(peer, peerDoc, { peer: 'second' });
const pageDoc = later.binding.doc;
const sync = (from: LoroDoc, to: LoroDoc) => {
  const update = from.export({ mode: 'update', from: to.oplogVersion() });
  if (update.length > 0) to.import(update);
};
sync(pageDoc, peerDoc);
// A commit or an import (the kernel's updates arrive as imports) on one side reaches the other.
pageDoc.subscribe(() => queueMicrotask(() => sync(pageDoc, peerDoc)));
peerDoc.subscribe(() => queueMicrotask(() => sync(peerDoc, pageDoc)));

const at = (ref: string) => ({ sheet: 's1', row: CODE[ref][0], col: CODE[ref][1] });
(window as unknown as { cellsCode: unknown }).cellsCode = {
  model,
  peer,
  run: (ref: string) => codeRunner(model).run(at(ref)),
  code: (ref: string) => model.code('s1', CODE[ref][0], CODE[ref][1]),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <h1>Cells code cells test page</h1>
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ height: 300, width: 560, position: 'relative' }}>
        <Spreadsheet model={model} aria-label="The page" />
      </div>
      <div style={{ height: 300, width: 560, position: 'relative' }}>
        <Spreadsheet model={peer} aria-label="The second peer" />
      </div>
    </div>
  </StrictMode>,
);
