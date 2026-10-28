/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import {
  CellsCellTypes,
  CellsCommands,
  CellsFunctions,
  cellsPatch,
  CellsProvider,
  createCellsModel,
  useCellsModel,
  useCommandTypes,
  useContributions,
  usePlugin,
  useSelection,
  useDispatch,
  type CellContent,
  type CellValue,
  toText,
  Spreadsheet,
} from '@datalayer/cells';
import { useState } from 'react';
import { Frame } from '../shared';

/**
 * A Reactor plugin, written as any third party would: a command and a
 * formula function (both work today), and a cell type (contributed and listed
 * today; drawn in C7-02).
 */
const ShoutPlugin = definePlugin({
  name: '@example/shout',
  displayName: 'Shout',
  contributes: [
    contribution(CellsCommands, {
      type: 'UPPERCASE',
      apply: (
        { workbook },
        command: {
          type: 'UPPERCASE';
          sheet: string;
          zone: { top: number; left: number; bottom: number; right: number };
        },
      ) => {
        const sheet = workbook.sheet(command.sheet);
        const contents: [number, number, CellContent][] = [];
        for (const [row, col, c] of sheet.cells.entries(command.zone)) {
          if (typeof c.value === 'string' && c.formula === undefined)
            contents.push([row, col, { ...c, value: c.value.toUpperCase() }]);
        }
        return [cellsPatch(sheet, command.zone, contents)];
      },
    }),
    contribution(CellsFunctions, {
      name: 'SHOUT',
      args: [{ name: 'text', type: 'scalar' }],
      returns: 'string',
      category: 'text',
      compute: ([text]) => toText(text as CellValue).toUpperCase(),
      description: 'The text in capitals.',
      examples: ['=SHOUT("hello") → HELLO'],
    }),
    contribution(CellsFunctions, {
      name: 'ECHO',
      args: [{ name: 'text', type: 'scalar' }],
      returns: 'string',
      category: 'text',
      async: true,
      // As a function fetching from a server would: #BUSY! until it answers.
      compute: ([text]) =>
        new Promise<CellValue>((resolve) =>
          setTimeout(
            () => resolve(`${toText(text as CellValue)}…${toText(text as CellValue)}`),
            600,
          ),
        ),
      description: 'The text, twice, after a while.',
      examples: ['=ECHO("hey") → hey…hey'],
    }),
    // A cell type: drawn by the plugin (the value in capitals, with a megaphone), named for a screen reader.
    contribution(CellsCellTypes, {
      id: 'megaphone',
      render: (ctx, rect, value, style, theme) => {
        ctx.font = `bold ${(style.size ?? theme.fontSize) * rect.zoom}px ${theme.fontFamily}`;
        ctx.fillStyle = style.color ?? theme.text;
        ctx.textBaseline = 'middle';
        ctx.fillText(
          `📣 ${toText(value).toUpperCase()}`,
          rect.x + 3 * rect.zoom,
          rect.y + rect.height / 2,
        );
      },
      accessibleName: (v) => `Shouted: ${toText(v).toUpperCase()}`,
    }),
  ],
});

function Panel() {
  const plugin = usePlugin('@example/shout');
  const types = useCommandTypes();
  const functions = useContributions(CellsFunctions);
  const cellTypes = useContributions(CellsCellTypes);
  const selection = useSelection();
  const { dispatch } = useDispatch();
  const [message, setMessage] = useState('');
  return (
    <div>
      <p>
        Plugin <code>@example/shout</code> is{' '}
        <strong>{plugin.enabled ? 'enabled' : 'disabled'}</strong>.{' '}
        <button onClick={() => (plugin.enabled ? plugin.disable() : plugin.enable())}>
          {plugin.enabled ? 'Disable' : 'Enable'} it
        </button>
      </p>
      <p>
        <button
          onClick={() => {
            const r = dispatch({
              type: 'UPPERCASE',
              sheet: selection.sheet,
              zone: selection.zones[0],
            });
            setMessage(r.ok ? 'Done.' : r.refusals[0].message);
          }}
        >
          UPPERCASE the selection
        </button>{' '}
        {message}
      </p>
      <ul>
        <li>Commands: {types.join(', ')}</li>
        <li>
          Formula functions:{' '}
          {functions.map((f) => `${f.value.name} (from ${f.plugin})`).join(', ') || 'none'}
        </li>
        <li>
          Cell types:{' '}
          {cellTypes.map((t) => `${t.value.id} (from ${t.plugin})`).join(', ') || 'none'}
        </li>
      </ul>
    </div>
  );
}

export default function Plugin() {
  const model = useCellsModel(() => {
    const m = createCellsModel({ plugins: [ShoutPlugin], limits: { rows: 100, cols: 10 } });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [
        ['hello', 'world'],
        ['quiet', 3],
        [{ formula: 'SHOUT(A2)' }, { formula: 'SHOUT(B1&"!")' }],
        [{ formula: 'ECHO(A1)' }, { formula: 'LEN(A4)' }],
      ],
    });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 1, left: 0, bottom: 1, right: 0 },
      style: { type: 'megaphone' },
    });
    m.select({
      sheet: 's1',
      zones: [{ top: 0, left: 0, bottom: 1, right: 1 }],
      anchor: { row: 0, col: 0 },
      active: { row: 0, col: 0 },
    });
    return m;
  });
  return (
    <CellsProvider model={model}>
      <p>
        The command and <code>=SHOUT(…)</code> work: disable the plugin and the command is refused
        as unknown, the third row shows <code>#NAME?</code>, and A2 (styled{' '}
        <code>{'{ type: "megaphone" }'}</code>) draws as a plain value again. <code>=ECHO(…)</code>{' '}
        is asynchronous: <code>#BUSY!</code>, then its value, and <code>LEN</code> beside it
        follows.
      </p>
      <Frame height={160}>
        <Spreadsheet model={model} aria-label="Plugin" />
      </Frame>
      <Panel />
    </CellsProvider>
  );
}
