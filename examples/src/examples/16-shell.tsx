/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { buildReactorFromPlugins, contribution, definePlugin } from '@datalayer/reactor';
import { ReactorSlot, useReactor } from '@datalayer/reactor/react';
import { getViewChoice, ShellPlugin, subscribeViewChoice } from '@datalayer/reactor-shell';
import { CellsFunctions, type CellsWorkbook } from '@datalayer/cells';
import { cellsShellPlugins, WorkbookCatalog } from '@datalayer/cells/plugin';
import { useState, useSyncExternalStore } from 'react';

/** Acme's price list: a column of TWICE, Acme's own function. */
const PRICES: CellsWorkbook = {
  version: 1,
  styles: [{}],
  sheets: [
    {
      id: 's1',
      name: 'Prices',
      rows: {
        '0': { cells: { '0': { v: 'Item' }, '1': { v: 'Price' }, '2': { v: 'Twice' } } },
        '1': { cells: { '0': { v: 'Apples' }, '1': { v: 3 }, '2': { f: 'TWICE(B2)', v: 0 } } },
        '2': { cells: { '0': { v: 'Pears' }, '1': { v: 4.5 }, '2': { f: 'TWICE(B3)', v: 0 } } },
      },
    },
  ],
};

/**
 * A plugin installed in the shell, as a third party writes one: a function
 * every grid the shell opens can call, and a workbook of its own in the list.
 */
export const AcmeShellPlugin = definePlugin({
  name: '@acme/shell-extras',
  displayName: 'Acme extras',
  description: 'TWICE(x) in every grid, and a price list in the workbooks.',
  contributes: [
    contribution(CellsFunctions, {
      name: 'TWICE',
      args: [{ name: 'x', type: 'scalar' }],
      returns: 'number',
      category: 'math',
      compute: ([x]) => (x as number) * 2,
      description: 'Twice a number.',
      examples: ['=TWICE(21) → 42'],
    }),
    contribution(
      WorkbookCatalog,
      {
        id: 'acme-prices',
        title: 'Acme prices',
        data: PRICES,
      },
      { id: 'acme-prices' },
    ),
  ],
});

/** The shell's platform: `@datalayer/reactor-shell`'s selector in the header, the Cells shell plugins, Acme's extras. */
export function shellPlatform() {
  return buildReactorFromPlugins([
    { plugin: ShellPlugin, config: { slot: 'header', ariaLabel: 'Workspace', noneLabel: 'Home' } },
    ...cellsShellPlugins(),
    AcmeShellPlugin,
  ]);
}

/**
 * A Reactor shell (C7-05): `@datalayer/reactor-shell` draws its view selector
 * from what plugins contribute; `CellsPlugin` contributes *Spreadsheets*, the
 * workbook list (sidebar slot) and the open workbook with its toolbar, formula
 * bar and sheet tabs (main slot). Every grid the shell opens runs on the
 * shell's own platform, so a function a plugin installs in the shell (Acme's
 * `TWICE`) works in each of them.
 */
export default function Shell() {
  const [platform] = useState(shellPlatform);
  useReactor(platform);
  const view = useSyncExternalStore(subscribeViewChoice, getViewChoice);
  return (
    <>
      <p>
        A Reactor shell: the selector below comes from <code>@datalayer/reactor-shell</code>, and
        its <em>Spreadsheets</em> view from <code>CellsPlugin</code>. Choose it to list the
        workbooks, make a new one, open one. Acme&apos;s plugin, installed in the shell, adds
        <code> =TWICE(x)</code> to every grid the shell opens, and its own price list.
      </p>
      <header data-shell-header="">
        <ReactorSlot slot="header" />
      </header>
      {view.viewId === 'spreadsheets' ? (
        <div
          data-shell-view="spreadsheets"
          style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, marginTop: 8 }}
        >
          <aside>
            <ReactorSlot slot="sidebar" />
          </aside>
          <div style={{ minHeight: 360, position: 'relative' }}>
            <ReactorSlot slot="main" />
          </div>
        </div>
      ) : (
        <p data-shell-view="none">Choose a view above.</p>
      )}
    </>
  );
}
