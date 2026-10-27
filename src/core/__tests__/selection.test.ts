/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import {
  dataEdge,
  initialSelection,
  navigate,
  type Navigation,
  type NavigationGrid,
  parseA1,
  parseZone,
  type SelectionState,
  toA1,
  zoneToA1,
} from '../index.js';

/**
 * A sheet for the table: column A holds a run A1:A3, a gap, then A6:A7;
 * row 1 holds A1:C1, then E1.
 */
const FILLED = new Set(['A1', 'A2', 'A3', 'A6', 'A7', 'B1', 'C1', 'E1']);
const grid: NavigationGrid = {
  rows: 20,
  cols: 10,
  has: (row, col) => FILLED.has(toA1({ row, col })),
  lastUsed: () => ({ row: 6, col: 4 }),
};

const at = (a1: string) => initialSelection('s1', parseA1(a1));
const range = (a1: string, active?: string): SelectionState => {
  const zone = parseZone(a1);
  const anchor = { row: zone.top, col: zone.left };
  return { sheet: 's1', zones: [zone], anchor, active: active ? parseA1(active) : anchor };
};

/** Excel's navigation, as a table: from, keys, to (the active cell, then the selection). */
const TABLE: [string, SelectionState, Navigation, string, string][] = [
  ['arrow down', at('B2'), { type: 'move', dir: 'down' }, 'B3', 'B3'],
  ['arrow up at the top edge stays', at('B1'), { type: 'move', dir: 'up' }, 'B1', 'B1'],
  [
    'Ctrl+Down inside a run goes to its end',
    at('A1'),
    { type: 'move', dir: 'down', jump: true },
    'A3',
    'A3',
  ],
  [
    'Ctrl+Down at the end of a run jumps the gap',
    at('A3'),
    { type: 'move', dir: 'down', jump: true },
    'A6',
    'A6',
  ],
  [
    'Ctrl+Down from an empty cell goes to the next filled one',
    at('A4'),
    { type: 'move', dir: 'down', jump: true },
    'A6',
    'A6',
  ],
  [
    'Ctrl+Down after the last run goes to the edge',
    at('A7'),
    { type: 'move', dir: 'down', jump: true },
    'A20',
    'A20',
  ],
  [
    'Ctrl+Right along a run, then over a gap',
    at('A1'),
    { type: 'move', dir: 'right', jump: true },
    'C1',
    'C1',
  ],
  [
    'Ctrl+Right from the end of a run',
    at('C1'),
    { type: 'move', dir: 'right', jump: true },
    'E1',
    'E1',
  ],
  ['Ctrl+Left from an empty cell', at('D1'), { type: 'move', dir: 'left', jump: true }, 'C1', 'C1'],
  [
    'Shift+Down extends, the active cell stays',
    at('B2'),
    { type: 'move', dir: 'down', extend: true },
    'B2',
    'B2:B3',
  ],
  [
    'Ctrl+Shift+Down extends to the data edge',
    at('A1'),
    { type: 'move', dir: 'down', jump: true, extend: true },
    'A1',
    'A1:A3',
  ],
  ['Enter on one cell moves down', at('B2'), { type: 'cycle', by: 'col' }, 'B3', 'B3'],
  ['Shift+Enter moves up', at('B2'), { type: 'cycle', by: 'col', reverse: true }, 'B1', 'B1'],
  ['Tab on one cell moves right', at('B2'), { type: 'cycle', by: 'row' }, 'C2', 'C2'],
  [
    'Enter in a range goes down inside it',
    range('B2:C3'),
    { type: 'cycle', by: 'col' },
    'B3',
    'B2:C3',
  ],
  [
    'Enter at the bottom of a range goes to the top of the next column',
    range('B2:C3', 'B3'),
    { type: 'cycle', by: 'col' },
    'C2',
    'B2:C3',
  ],
  [
    'Enter at the last cell wraps to the first',
    range('B2:C3', 'C3'),
    { type: 'cycle', by: 'col' },
    'B2',
    'B2:C3',
  ],
  [
    'Tab in a range goes along the row, then the next',
    range('B2:C3', 'C2'),
    { type: 'cycle', by: 'row' },
    'B3',
    'B2:C3',
  ],
  [
    'Shift+Tab at the first cell wraps to the last',
    range('B2:C3'),
    { type: 'cycle', by: 'row', reverse: true },
    'C3',
    'B2:C3',
  ],
  ['Home goes to column A', at('D5'), { type: 'home' }, 'A5', 'A5'],
  ['Ctrl+Home goes to A1', at('D5'), { type: 'home', ctrl: true }, 'A1', 'A1'],
  ['Ctrl+End goes to the last used cell', at('A1'), { type: 'end' }, 'E7', 'E7'],
  [
    'PageDown moves a page of rows',
    at('B2'),
    { type: 'page', dir: 'down', rows: 10 },
    'B12',
    'B12',
  ],
  ['PageUp stops at the top', at('B2'), { type: 'page', dir: 'up', rows: 10 }, 'B1', 'B1'],
  ['Ctrl+Space selects the columns', range('B2:C3'), { type: 'selectColumns' }, 'B2', 'B1:C20'],
  ['Shift+Space selects the rows', range('B2:C3'), { type: 'selectRows' }, 'B2', 'A2:J3'],
  ['Ctrl+A selects the sheet', at('C3'), { type: 'selectAll' }, 'C3', 'A1:J20'],
];

describe('keyboard navigation, after Excel', () => {
  for (const [name, from, nav, active, selection] of TABLE) {
    it(name, () => {
      const s = navigate(from, nav, grid);
      expect(toA1(s.active)).toBe(active);
      expect(s.zones.map(zoneToA1).join(',')).toBe(selection);
    });
  }

  it('Ctrl+arrows stop at the edge they start on', () => {
    expect(dataEdge(parseA1('A1'), 'up', grid)).toEqual(parseA1('A1'));
  });
});

describe('the selection stream', () => {
  it('tells every observer, and refuses a selection on a missing sheet', async () => {
    const { createCellsModel } = await import('../index.js');
    const m = createCellsModel({ limits: { rows: 20, cols: 10 } });
    const seen: string[] = [];
    m.subscribeSelection((s) => seen.push(toA1(s.active)));
    m.subscribeSelection((s) => seen.push(`2:${toA1(s.active)}`));
    m.select(at('C4'));
    expect(seen).toEqual(['C4', '2:C4']);
    expect(() => m.select({ ...at('A1'), sheet: 'nope' })).toThrow(/No sheet 'nope'/);
  });
});

describe('moves over hidden rows and columns', () => {
  it('steps over them, and stays put when they reach the edge', () => {
    const hiddenGrid: NavigationGrid = {
      ...grid,
      hidden: (axis, i) => (axis === 'rows' ? i === 2 || i === 19 : i === 1),
    };
    expect(toA1(navigate(at('A2'), { type: 'move', dir: 'down' }, hiddenGrid).active)).toBe('A4');
    expect(toA1(navigate(at('A1'), { type: 'move', dir: 'right' }, hiddenGrid).active)).toBe('C1');
    expect(toA1(navigate(at('A19'), { type: 'move', dir: 'down' }, hiddenGrid).active)).toBe('A19');
  });
});
