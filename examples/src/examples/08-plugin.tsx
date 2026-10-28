/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { buildReactorFromPlugins, type ContributionPoint } from '@datalayer/reactor';
import {
  CELLS_POINTS,
  CellsCorePlugin,
  CellsProvider,
  createCellsModel,
  type CellsModel,
  Spreadsheet,
  useCellsModel,
  useCellsReactor,
  useCellsRevision,
  useDataSource,
  usePlugin,
  useSelection,
  useDispatch,
} from '@datalayer/cells';
import { Toolbar } from '@datalayer/cells/chrome';
import { useMemo, useState } from 'react';
import { Frame } from '../shared';
import {
  ACME_PLUGIN,
  AcmePlugin,
  notes,
  readMarkdownTable,
  TwicePlugin,
  writeMarkdownTable,
} from './plugin/acme';

/**
 * A third-party Reactor plugin (`./plugin/acme.ts`) that reaches every
 * `datalayer.cells.*` point, on a grid built from `CellsCorePlugin` and that
 * plugin alone: no built-in function, cell type, fill rule, clipboard
 * handler, importer or chrome command is loaded here. The plugin guide in
 * `docs/plugins.md` walks through the same file, point by point.
 */
function bareModel(): CellsModel {
  const reactor = buildReactorFromPlugins([CellsCorePlugin, AcmePlugin]);
  reactor.start();
  const m = createCellsModel({ reactor, limits: { rows: 200_000, cols: 12 } });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 1, col: 0 },
    cells: [
      ['hello', 'world', 'I', { formula: 'SHOUT(A2)' }],
      ['quiet', 3, 'II', { formula: 'ECHO(A3)' }],
      ['loud', null, 'III', { formula: 'SUM(B2:B3)' }],
    ],
  });
  // Row 1 is the plugin's locked header row: written here before the gate sees a command (loadColumns is a load, not a command).
  m.loadColumns('s1', { row: 0, col: 0 }, [
    ['Text'],
    ['Number'],
    ['Roman'],
    ['Formula'],
    [null],
    ['n'],
    ['prime'],
  ]);
  m.dispatch({
    type: 'SET_STYLE',
    sheet: 's1',
    zone: { top: 3, left: 0, bottom: 3, right: 0 },
    style: { type: 'megaphone' },
  });
  m.dispatch({ type: 'SET_NOTE', sheet: 's1', row: 2, col: 1, text: 'Check this' });
  m.dispatch({
    type: 'BIND_DATA_SOURCE',
    sheet: 's1',
    source: 'acme.primes',
    at: { row: 1, col: 5 },
  });
  m.select({
    sheet: 's1',
    zones: [{ top: 1, left: 0, bottom: 2, right: 1 }],
    anchor: { row: 1, col: 0 },
    active: { row: 1, col: 0 },
  });
  return m;
}

const LABELS: Record<string, string> = {
  'datalayer.cells.patchOp': 'patch ops',
  'datalayer.cells.command': 'commands',
  'datalayer.cells.function': 'functions',
  'datalayer.cells.cellType': 'cell types',
  'datalayer.cells.renderLayer': 'render layers',
  'datalayer.cells.clipboard': 'clipboard handlers',
  'datalayer.cells.fillRule': 'fill rules',
  'datalayer.cells.importer': 'importers',
  'datalayer.cells.exporter': 'exporters',
  'datalayer.cells.dataSource': 'data sources',
  'datalayer.cells.collabProvider': 'collaboration providers',
  'datalayer.cells.toolbarItem': 'toolbar items',
  'datalayer.cells.menuItem': 'menu items',
  'datalayer.cells.chartType': 'chart types',
  'datalayer.cells.chartOption': 'chart option transforms',
  'datalayer.cells.chartRenderer': 'chart renderers',
  'datalayer.cells.gate.edit': 'edit gates',
};

function Points() {
  const reactor = useCellsReactor();
  const revision = useCellsRevision();
  const rows = useMemo(
    () =>
      CELLS_POINTS.map((point) => ({
        id: point.id,
        label: LABELS[point.id] ?? point.id,
        ids: reactor
          .getContributions(point as ContributionPoint<unknown>)
          .filter((c) => c.plugin === ACME_PLUGIN)
          .map((c) => c.id),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reactor, revision],
  );
  return (
    <table aria-label="Contribution points">
      <thead>
        <tr>
          <th>Point</th>
          <th>Contributed by @acme/everything</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <code>{r.id}</code> ({r.label})
            </td>
            <td>{r.ids.join(', ') || 'none'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Panel({ model }: { model: CellsModel }) {
  const plugin = usePlugin(ACME_PLUGIN);
  const selection = useSelection();
  const { dispatch } = useDispatch();
  const revision = useCellsRevision();
  const { source, stats } = useDataSource();
  const [message, setMessage] = useState('');
  const [markdown, setMarkdown] = useState(
    '| Item | Qty |\n|---|---|\n| Bolt | 3 |\n| Nut | =1+1 |',
  );
  const [duplicate, setDuplicate] = useState('');
  const noted = useMemo(() => [...notes(model.workbook).keys()].sort(), [model, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <p>
        Plugin <code>@acme/everything</code> is{' '}
        <strong>{plugin.enabled ? 'enabled' : 'disabled'}</strong>.{' '}
        <button onClick={() => (plugin.enabled ? plugin.disable() : plugin.enable())}>
          {plugin.enabled ? 'Disable' : 'Enable'} it
        </button>{' '}
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
        <button
          onClick={() => {
            const { sheet, active } = selection;
            const r = dispatch({
              type: 'SET_NOTE',
              sheet,
              row: active.row,
              col: active.col,
              text: 'Check this',
            });
            setMessage(r.ok ? 'Noted.' : r.refusals[0].message);
          }}
        >
          Note the active cell
        </button>{' '}
        <button
          onClick={() => {
            const r = dispatch({
              type: 'SET_CELLS',
              sheet: selection.sheet,
              at: { row: 0, col: 0 },
              cells: [['Header']],
            });
            setMessage(r.ok ? 'Written.' : r.refusals[0].message);
          }}
        >
          Write into row 1
        </button>{' '}
        <output data-message="">{message}</output>
      </p>
      <p>
        Notes (the <code>acme.note</code> patch op, drawn by the <code>acme.noteMarks</code> layer
        as a red corner, carried by the <code>acme.notes</code> clipboard handler):{' '}
        {noted.join(', ') || 'none'}. The <code>acme.primes</code> data source is{' '}
        {source === undefined ? 'unbound' : `bound at F2: ${stats.resident} page(s) resident`}.
      </p>
      <p>
        <label>
          A Markdown table, read by the <code>acme.markdown</code> importer:{' '}
          <textarea
            aria-label="Markdown table"
            rows={4}
            cols={40}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
        </label>{' '}
        <button
          onClick={() => {
            const workbook = readMarkdownTable(markdown);
            const rows = workbook.sheets[0].rows;
            const cells = Object.entries(rows).map(([r, row]) => [Number(r), row.cells] as const);
            const height = Math.max(...cells.map(([r]) => r)) + 1;
            const width = Math.max(...cells.flatMap(([, c]) => Object.keys(c).map(Number))) + 1;
            const block = Array.from({ length: height }, (_, r) =>
              Array.from({ length: width }, (_, c) => {
                const cell = rows[String(r)]?.cells[String(c)];
                if (cell === undefined) return null;
                return cell.f !== undefined ? { formula: cell.f } : (cell.v as never);
              }),
            );
            const r = dispatch({
              type: 'SET_CELLS',
              sheet: selection.sheet,
              at: { row: 6, col: 0 },
              cells: block,
            });
            setMessage(r.ok ? 'Imported at A7.' : r.refusals[0].message);
          }}
        >
          Import at A7
        </button>{' '}
        <button onClick={() => setMarkdown(writeMarkdownTable(model))}>
          Export the sheet as Markdown
        </button>
      </p>
      <p>
        <button
          onClick={() => {
            try {
              const reactor = buildReactorFromPlugins([CellsCorePlugin, AcmePlugin, TwicePlugin]);
              reactor.start();
              createCellsModel({ reactor });
              setDuplicate('A second grid started, which should not have happened.');
            } catch (error) {
              setDuplicate((error as Error).message);
            }
          }}
        >
          Start a grid with a duplicate plugin
        </button>{' '}
        <output data-duplicate="">{duplicate}</output>
      </p>
    </div>
  );
}

export default function Plugin() {
  const model = useCellsModel(bareModel);
  return (
    <CellsProvider model={model}>
      <p>
        The grid below runs on <code>CellsCorePlugin</code> and <code>@acme/everything</code> only:{' '}
        <code>=SHOUT(A2)</code> and the asynchronous <code>=ECHO(A3)</code> (<code>#BUSY!</code>,
        then its value) come from the plugin, <code>=SUM(B2:B3)</code> is <code>#NAME?</code> since
        no function plugin is loaded, A4 is drawn by the plugin's <code>megaphone</code> cell type,
        column F is its <code>acme.primes</code> data source, the toolbar holds its two commands,
        row 1 is locked by its edit gate, and the fill handle extends Roman numerals (C2:C4) once
        the built-in fill plugin is added. Disable the plugin and every one of these goes.
      </p>
      <Toolbar charts={false} />
      <Frame height={200}>
        <Spreadsheet model={model} aria-label="Plugin" />
      </Frame>
      <Panel model={model} />
      <Points />
    </CellsProvider>
  );
}
