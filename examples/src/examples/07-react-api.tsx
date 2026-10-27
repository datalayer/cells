/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  type CellsHandle,
  CellsProvider,
  CORE_EXPORTS,
  MODEL_MEMBERS,
  Spreadsheet,
  toA1,
  useCellValue,
  useCellsFromRows,
  useHistory,
  useRange,
  useSelection,
  useSheets,
} from '@datalayer/cells';
import { useRef, useState } from 'react';
import { Frame } from '../shared';

function Live() {
  const total = useCellValue('B2');
  const range = useRange('A1:B3');
  const selection = useSelection();
  const sheets = useSheets();
  const history = useHistory();
  return (
    <ul>
      <li>
        <code>useCellValue('B2')</code> → {String(total)}
      </li>
      <li>
        <code>useRange('A1:B3')</code> → <code>{JSON.stringify(range)}</code>
      </li>
      <li>
        <code>useSelection().active</code> →{' '}
        <span data-testid="active">{toA1(selection.active)}</span>
      </li>
      <li>
        <code>useSheets().sheets</code> → {sheets.sheets.map((s) => s.name).join(', ')}{' '}
        <button onClick={() => sheets.add()}>add a sheet</button>
      </li>
      <li>
        <code>useHistory()</code> → canUndo {String(history.canUndo)}{' '}
        <button disabled={!history.canUndo} onClick={() => history.undo()}>
          undo
        </button>
      </li>
    </ul>
  );
}

function Parity({
  title,
  map,
}: {
  title: string;
  map: Readonly<Record<string, { kind: string; name?: string }>>;
}) {
  return (
    <details>
      <summary>
        {title}: {Object.keys(map).length} entries
      </summary>
      <table className="grid">
        <tbody>
          {Object.entries(map).map(([name, s]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td>
                {s.kind === 'reexport'
                  ? 'used as it is from @datalayer/cells'
                  : `${s.kind} ${s.name}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** The hooks and the imperative handle, live, and the parity map a test holds the core to. */
export default function ReactApi() {
  const model = useCellsFromRows([
    ['x', 1],
    ['y', 2],
    ['z', 3],
  ]);
  const handle = useRef<CellsHandle>(null);
  const [events, setEvents] = useState<string[]>([]);
  const log = (e: string) => setEvents((list) => [e, ...list].slice(0, 5));
  return (
    <CellsProvider model={model}>
      <p>
        Handle: <button onClick={() => handle.current?.select('B2:B3')}>select('B2:B3')</button>
        <button onClick={() => handle.current?.scrollTo('A500', { align: 'start' })}>
          scrollTo('A500')
        </button>
        <button onClick={() => handle.current?.scrollTo('A1', { align: 'start' })}>
          scrollTo('A1')
        </button>
        <button onClick={() => handle.current?.focus()}>focus()</button>
      </p>
      <Frame height={200}>
        <Spreadsheet
          ref={handle}
          model={model}
          aria-label="React API"
          onSelectionChange={(s) => log(`onSelectionChange ${toA1(s.active)}`)}
          onCellClick={(c) => log(`onCellClick ${toA1(c)}`)}
          onChange={(tx) => log(`onChange ${tx.label} (${tx.origin})`)}
        />
      </Frame>
      <p>Events: {events.join(' · ') || 'none yet'}</p>
      <Live />
      <Parity title="Every core export and its React surface" map={CORE_EXPORTS} />
      <Parity title="Every model member and its React surface" map={MODEL_MEMBERS} />
    </CellsProvider>
  );
}
