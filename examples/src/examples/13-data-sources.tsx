/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import {
  CellsDataSources,
  CellsProvider,
  createCellsModel,
  type DataSource,
  type DataSourceError,
  PAGE_ROWS,
  Spreadsheet,
  useCellsModel,
  useDataSource,
  useRange,
} from '@datalayer/cells';
import { useState } from 'react';
import { Frame } from '../shared';

const ROWS = 10_000_000;
const PRODUCTS = ['Widget', 'Gadget', 'Gizmo', 'Doohickey', 'Thingamajig', 'Whatsit', 'Sprocket'];

/** What may go wrong on the next fetch: a knob the page turns. */
const faults = { failNext: false };

/**
 * A synthetic data source of ten million orders, each row computed from its
 * index, answered a page at a time after a short delay, as a server would.
 * `#BUSY!` shows in the cells of a page on its way; `#N/A` in those of a page
 * that failed, with `onDataSourceError` told.
 */
const orders: DataSource = {
  id: 'orders',
  rowCount: ROWS,
  columns: [
    { name: 'Order', type: 'number' },
    { name: 'Product', type: 'string' },
    { name: 'Quantity', type: 'number' },
    { name: 'Amount', type: 'number' },
  ],
  fetch: ({ from, to }) =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        if (faults.failNext) {
          faults.failNext = false;
          reject(new Error(`the orders server did not answer for rows ${from + 1}–${to + 1}`));
          return;
        }
        const n = to - from + 1;
        const quantity = (i: number) => ((i * 7919) % 12) + 1;
        resolve([
          Array.from({ length: n }, (_, i) => from + i + 1),
          Array.from({ length: n }, (_, i) => PRODUCTS[(from + i) % PRODUCTS.length]),
          Array.from({ length: n }, (_, i) => quantity(from + i)),
          Array.from({ length: n }, (_, i) => quantity(from + i) * (((from + i) % 5) + 1) * 2.5),
        ]);
      }, 250);
    }),
};

const OrdersPlugin = definePlugin({
  name: '@example/orders',
  displayName: 'Orders',
  contributes: [contribution(CellsDataSources, orders, { id: 'orders' })],
});

function Status({ errors }: { errors: readonly DataSourceError[] }) {
  const { source, stats } = useDataSource();
  const [[total, count]] = useRange('G2:H2');
  return (
    <div>
      <p data-source-status="">
        {source === undefined
          ? 'No data source is bound.'
          : `The data source '${source.binding.id}' (${source.binding.rows.toLocaleString('en-US')} rows, ${source.binding.cols} columns) is bound from B3` +
            (source.source ? ` by ${source.source.plugin}.` : `: ${source.problem}`)}{' '}
        Pages of {PAGE_ROWS.toLocaleString('en-US')} rows: {stats.resident} resident of{' '}
        {stats.capacity}, {stats.loading} loading, {stats.failed} failed; {stats.fetches} fetched,{' '}
        {stats.evictions} evicted.
      </p>
      <p>
        <code>=SUM(E3:E2050)</code> is <strong>{String(total)}</strong> and{' '}
        <code>=COUNTA(C3:C2050)</code> is <strong>{String(count)}</strong>: both wait on two pages,
        then settle.
      </p>
      {errors.length > 0 && (
        <ul aria-label="Data source errors">
          {errors.map((e, i) => (
            <li key={i}>
              {e.source}, rows {e.rows.from + 1}–{e.rows.to + 1}: {e.error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DataSources() {
  const [errors, setErrors] = useState<DataSourceError[]>([]);
  const model = useCellsModel(() => {
    const m = createCellsModel({
      plugins: [OrdersPlugin],
      limits: { rows: ROWS + 10, cols: 12 },
      dataSources: { pages: 64 },
    });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 1 },
      cells: [
        [
          'Ten million orders, read a page at a time',
          null,
          null,
          null,
          null,
          'Amount, first 2,048',
          'Products',
        ],
        [
          'Order',
          'Product',
          'Quantity',
          'Amount',
          null,
          { formula: 'SUM(E3:E2050)' },
          { formula: 'COUNTA(C3:C2050)' },
        ],
      ],
    });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 1, left: 1, bottom: 1, right: 4 },
      style: { bold: true },
    });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 0, left: 6, bottom: 0, right: 7 },
      style: { bold: true },
    });
    m.dispatch({
      type: 'SET_STYLE',
      sheet: 's1',
      zone: { top: 2, left: 4, bottom: ROWS + 1, right: 4 },
      style: { format: '#,##0.00' },
    });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 2, to: 2, size: 120 });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 6, to: 7, size: 150 });
    m.dispatch({ type: 'FREEZE', sheet: 's1', rows: 2, cols: 0 });
    const bound = m.dispatch({
      type: 'BIND_DATA_SOURCE',
      sheet: 's1',
      source: 'orders',
      at: { row: 2, col: 1 },
    });
    if (!bound.ok) throw new Error(bound.refusals[0].message);
    return m;
  });
  return (
    <CellsProvider model={model}>
      <p>
        A <strong>data source</strong> is a plugin's contribution to{' '}
        <code>datalayer.cells.dataSource</code>: an id, a row count, columns and{' '}
        <code>fetch(rows)</code>. A sheet binds one at a cell with <code>BIND_DATA_SOURCE</code>;
        its rows then show from there, read in pages as you scroll and as formulas read them,{' '}
        <code>#BUSY!</code> while a page is on its way. The pages are read, never saved, and the
        bound cells cannot be edited. Scroll to the bottom (Ctrl+End) to reach row ten million.{' '}
        <button
          onClick={() => {
            faults.failNext = true;
            model.refreshDataSource('s1');
          }}
        >
          Fail the next page
        </button>{' '}
        <button onClick={() => model.refreshDataSource('s1')}>Read again</button>
      </p>
      <Frame height={300}>
        <Spreadsheet
          model={model}
          aria-label="Orders"
          onDataSourceError={(e) => setErrors((list) => [...list, e])}
        />
      </Frame>
      <Status errors={errors} />
    </CellsProvider>
  );
}
