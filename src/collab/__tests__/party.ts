/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The monkey party's dice and commands (C6-05), shared by the TypeScript-only
 * party (`monkey.test.ts`) and the party with a Python peer (`monkeyPython.test.ts`).
 */

import { type CellsModel, type Command, zoneRef } from '../../core/index.js';

/** The party's sheet: small, so commands collide. */
export const LIMITS = { rows: 30, cols: 8 };

const z = (top: number, left: number, bottom: number, right: number) => ({
  top,
  left,
  bottom,
  right,
});

/** A seeded generator (mulberry32). */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]) => xs[int(xs.length)] };
}

export function command(m: CellsModel, r: ReturnType<typeof random>): Command | undefined {
  const sheet = r.pick(m.sheets).id;
  const row = r.int(LIMITS.rows - 4);
  const col = r.int(LIMITS.cols - 2);
  const zone = { top: row, left: col, bottom: row + r.int(2), right: col + r.int(2) };
  switch (r.int(13)) {
    case 0:
    case 1:
    case 2:
      return { type: 'SET_CELLS', sheet, at: { row, col }, cells: [[r.int(100), `t${r.int(10)}`]] };
    case 3:
      return {
        type: 'SET_CELLS',
        sheet,
        at: { row, col },
        cells: [[{ formula: r.pick(['A1+1', 'SUM(A1:B3)', '$B$2*2', 'C3&"!"']) }]],
      };
    case 4:
      return { type: 'CLEAR', sheet, zone };
    case 5:
      return {
        type: 'INSERT_AXIS',
        sheet,
        axis: r.pick(['rows', 'cols'] as const),
        at: r.int(5),
        n: 1 + r.int(2),
      };
    case 6:
      return {
        type: 'DELETE_AXIS',
        sheet,
        axis: r.pick(['rows', 'cols'] as const),
        at: r.int(6),
        n: 1,
      };
    case 7:
      return { type: 'MOVE_AXIS', sheet, axis: 'rows', at: r.int(4), n: 1, to: 6 + r.int(4) };
    case 8:
      return r.int(2) === 0 ? { type: 'MERGE', sheet, zone } : { type: 'UNMERGE', sheet, zone };
    case 9:
      return {
        type: 'SET_STYLE',
        sheet,
        zone,
        style: { bold: r.int(2) === 0, fill: r.pick(['#ff0', '#0ff']) },
      };
    case 10:
      return { type: 'RESIZE_AXIS', sheet, axis: 'cols', from: col, to: col, size: 40 + r.int(80) };
    case 11: {
      // Charts (C10-08): inserted on the sheet's first cells, retitled, retyped, moved, deleted.
      const charts = [...m.sheet(sheet).charts.keys()];
      const name = m.sheet(sheet).name;
      const id = charts.length > 0 ? r.pick(charts) : undefined;
      switch (id === undefined ? 0 : r.int(4)) {
        case 0:
          return {
            type: 'INSERT_CHART',
            sheet,
            chart: {
              type: r.pick(['column', 'line', 'pie'] as const),
              anchor: {
                kind: 'cells',
                from: { row, col, dx: 0, dy: 0 },
                to: { row: row + 3, col: col + 1, dx: 0, dy: 0 },
              },
              data: {
                series: [
                  {
                    values: zoneRef(name, z(0, 0, 2, 0)),
                    categories: zoneRef(name, z(0, 1, 2, 1)),
                  },
                  { values: zoneRef(name, z(0, 1, 2, 1)) },
                ],
                by: 'columns',
                headers: { row: false, column: false },
                blanks: 'gap',
              },
              legend: 'bottom',
            },
          };
        case 1:
          return {
            type: 'UPDATE_CHART',
            sheet,
            id: id!,
            changes:
              r.int(2) === 0
                ? { title: `T${r.int(100)}` }
                : { type: r.pick(['column', 'line', 'bar'] as const) },
          };
        case 2:
          return { type: 'MOVE_CHART', sheet, id: id!, to: { row, col } };
        default:
          return { type: 'DELETE_CHART', sheet, id: id! };
      }
    }
    default:
      return m.sheets.length < 3 && r.int(2) === 0
        ? { type: 'ADD_SHEET', name: `S${r.int(1000)}` }
        : m.sheets.length > 1
          ? { type: 'DELETE_SHEET', sheet }
          : undefined;
  }
}

/** JSON with its keys sorted at every level: two peers' workbooks compare whatever order their fields were written in. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'object' && x !== null && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
