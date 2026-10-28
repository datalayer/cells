/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The selection: view state (never undone, never synced), and the keyboard's
 * movement semantics as pure functions, after Excel and Sheets. The model
 * holds the current selection and streams its changes; the grid, the editor,
 * the name box and plugins observe that one stream.
 *
 * @module core/selection
 */

import { type Position, type Zone, zoneContains, zoneOf } from './zone.js';

/** The selection (view state): its sheet, zones, anchor and active cell. */
export interface SelectionState {
  readonly sheet: string;
  /** At least one; the last is the one being edited by Shift+arrows. */
  readonly zones: readonly Zone[];
  /** The fixed corner of the last zone. */
  readonly anchor: Position;
  /** The active cell: where typing goes. Inside the last zone. */
  readonly active: Position;
}

/** What navigation needs to know of a sheet. */
export interface NavigationGrid {
  readonly rows: number;
  readonly cols: number;
  /** Whether a cell holds a value (for Ctrl+arrows' data edges). */
  has(row: number, col: number): boolean;
  /** The last row and column holding data (Ctrl+End). */
  lastUsed(): Position;
  /** Whether a row or a column is hidden: moves step over hidden ones, as Excel's do. */
  hidden?(axis: 'rows' | 'cols', index: number): boolean;
}

/** A direction of a keyboard move. */
export type Direction = 'up' | 'down' | 'left' | 'right';

/** A keyboard move, as `navigate` takes it. */
export type Navigation =
  | {
      readonly type: 'move';
      readonly dir: Direction;
      readonly jump?: boolean;
      readonly extend?: boolean;
    }
  /** Enter (by: 'col', down) and Tab (by: 'row', right); Shift reverses. Cycles inside a multi-cell selection. */
  | { readonly type: 'cycle'; readonly by: 'row' | 'col'; readonly reverse?: boolean }
  /** Home, Ctrl+Home. */
  | { readonly type: 'home'; readonly ctrl?: boolean; readonly extend?: boolean }
  /** Ctrl+End. */
  | { readonly type: 'end'; readonly extend?: boolean }
  | {
      readonly type: 'page';
      readonly dir: 'up' | 'down';
      readonly rows: number;
      readonly extend?: boolean;
    }
  /** Ctrl+Space. */
  | { readonly type: 'selectColumns' }
  /** Shift+Space. */
  | { readonly type: 'selectRows' }
  /** Ctrl+A. */
  | { readonly type: 'selectAll' };

/** A selection of one cell (A1 by default) on a sheet. */
export function initialSelection(sheet: string, at: Position = { row: 0, col: 0 }): SelectionState {
  return { sheet, zones: [zoneOf(at)], anchor: at, active: at };
}

/** A single-cell selection at `at`, or the last zone extended to it. */
export function selectCell(s: SelectionState, at: Position, extend = false): SelectionState {
  if (!extend) return initialSelection(s.sheet, at);
  return { ...s, zones: [...s.zones.slice(0, -1), zoneOf(s.anchor, at)] };
}

/** Add a zone (Ctrl+click), making its corner the anchor and active cell. */
export function addZone(s: SelectionState, zone: Zone): SelectionState {
  const at = { row: zone.top, col: zone.left };
  return { ...s, zones: [...s.zones, zone], anchor: at, active: at };
}

const STEP: Record<Direction, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

function clamp(p: Position, g: NavigationGrid): Position {
  return {
    row: Math.min(Math.max(p.row, 0), g.rows - 1),
    col: Math.min(Math.max(p.col, 0), g.cols - 1),
  };
}

function inside(p: Position, g: NavigationGrid): boolean {
  return p.row >= 0 && p.col >= 0 && p.row < g.rows && p.col < g.cols;
}

/** One step in a direction, over hidden rows and columns; staying put at the edge. */
function step(p: Position, dir: Direction, g: NavigationGrid): Position {
  const [dr, dc] = STEP[dir];
  let q = clamp({ row: p.row + dr, col: p.col + dc }, g);
  const axis = dr !== 0 ? 'rows' : 'cols';
  while (g.hidden?.(axis, axis === 'rows' ? q.row : q.col)) {
    const next = clamp({ row: q.row + dr, col: q.col + dc }, g);
    if (next.row === q.row && next.col === q.col) return p; // hidden up to the edge: stay
    q = next;
  }
  return q;
}

/**
 * Ctrl+arrow from `p`: through a run of filled cells to its last one; from an
 * empty cell, or from the end of a run, to the next filled cell; to the edge
 * when there is none.
 */
export function dataEdge(p: Position, dir: Direction, g: NavigationGrid): Position {
  const [dr, dc] = STEP[dir];
  const next = (q: Position) => ({ row: q.row + dr, col: q.col + dc });
  let q = next(p);
  if (!inside(q, g)) return p;
  if (g.has(p.row, p.col) && g.has(q.row, q.col)) {
    while (inside(next(q), g) && g.has(next(q).row, next(q).col)) q = next(q);
    return q;
  }
  while (!g.has(q.row, q.col) && inside(next(q), g)) q = next(q);
  return q;
}

/** The corner of the last zone opposite the anchor: what Shift+arrows move. */
function movingCorner(s: SelectionState): Position {
  const z = s.zones[s.zones.length - 1];
  return {
    row: s.anchor.row === z.top ? z.bottom : z.top,
    col: s.anchor.col === z.left ? z.right : z.left,
  };
}

function extendTo(s: SelectionState, corner: Position): SelectionState {
  return { ...s, zones: [...s.zones.slice(0, -1), zoneOf(s.anchor, corner)] };
}

/** The selection after a keyboard move (arrows, data edges, pages, Home and End, extending with Shift). */
export function navigate(s: SelectionState, nav: Navigation, g: NavigationGrid): SelectionState {
  switch (nav.type) {
    case 'move': {
      const from = nav.extend ? movingCorner(s) : s.active;
      const to = nav.jump ? dataEdge(from, nav.dir, g) : step(from, nav.dir, g);
      return nav.extend ? extendTo(s, to) : initialSelection(s.sheet, to);
    }
    case 'cycle':
      return cycle(s, nav.by, nav.reverse ?? false, g);
    case 'home': {
      const corner = nav.extend ? movingCorner(s) : s.active;
      const to = nav.ctrl ? { row: 0, col: 0 } : { row: corner.row, col: 0 };
      return nav.extend ? extendTo(s, to) : initialSelection(s.sheet, to);
    }
    case 'end': {
      const to = g.lastUsed();
      return nav.extend ? extendTo(s, to) : initialSelection(s.sheet, to);
    }
    case 'page': {
      const corner = nav.extend ? movingCorner(s) : s.active;
      const to = clamp(
        { row: corner.row + (nav.dir === 'down' ? nav.rows : -nav.rows), col: corner.col },
        g,
      );
      return nav.extend ? extendTo(s, to) : initialSelection(s.sheet, to);
    }
    case 'selectColumns': {
      const z = s.zones[s.zones.length - 1];
      return {
        ...s,
        zones: [
          ...s.zones.slice(0, -1),
          { top: 0, bottom: g.rows - 1, left: z.left, right: z.right },
        ],
      };
    }
    case 'selectRows': {
      const z = s.zones[s.zones.length - 1];
      return {
        ...s,
        zones: [
          ...s.zones.slice(0, -1),
          { top: z.top, bottom: z.bottom, left: 0, right: g.cols - 1 },
        ],
      };
    }
    case 'selectAll':
      return { ...s, zones: [{ top: 0, left: 0, bottom: g.rows - 1, right: g.cols - 1 }] };
  }
}

/**
 * Enter and Tab. With one cell selected, the active cell moves (down, or
 * right) and the selection follows. With a range, the active cell cycles
 * inside the zones and the selection stays: Enter goes down a column then to
 * the top of the next, Tab along a row then to the start of the next, and
 * from the last cell of a zone to the first of the next zone.
 */
function cycle(
  s: SelectionState,
  by: 'row' | 'col',
  reverse: boolean,
  g: NavigationGrid,
): SelectionState {
  const single =
    s.zones.length === 1 &&
    s.zones[0].top === s.zones[0].bottom &&
    s.zones[0].left === s.zones[0].right;
  if (single) {
    const dir: Direction = by === 'col' ? (reverse ? 'up' : 'down') : reverse ? 'left' : 'right';
    const [dr, dc] = STEP[dir];
    return initialSelection(s.sheet, clamp({ row: s.active.row + dr, col: s.active.col + dc }, g));
  }
  let zi = s.zones.findIndex((z) => zoneContains(z, s.active));
  if (zi < 0) zi = s.zones.length - 1;
  const z = s.zones[zi];
  let { row, col } = s.active;
  const step = reverse ? -1 : 1;
  const nextZone = () => {
    zi = (zi + step + s.zones.length) % s.zones.length;
    const n = s.zones[zi];
    return reverse ? { row: n.bottom, col: n.right } : { row: n.top, col: n.left };
  };
  let to: Position;
  if (by === 'col') {
    row += step;
    if (row > z.bottom || row < z.top) {
      col += step;
      row = reverse ? z.bottom : z.top;
      to = col > z.right || col < z.left ? nextZone() : { row, col };
    } else to = { row, col };
  } else {
    col += step;
    if (col > z.right || col < z.left) {
      row += step;
      col = reverse ? z.right : z.left;
      to = row > z.bottom || row < z.top ? nextZone() : { row, col };
    } else to = { row, col };
  }
  return { ...s, active: to };
}

/** The navigation grid of a sheet of a model: its counts, what holds data, the last used cell. */
export function navigationGrid(sheet: {
  readonly rows: { readonly count: number; isHidden(index: number): boolean };
  readonly cols: { readonly count: number; isHidden(index: number): boolean };
  readonly cells: {
    get(row: number, col: number): { readonly value: unknown; readonly formula?: string } | null;
    columnIndexes(): IterableIterator<number>;
    lastRowIn(col: number): number;
  };
}): NavigationGrid {
  return {
    rows: sheet.rows.count,
    cols: sheet.cols.count,
    has: (row, col) => {
      const c = sheet.cells.get(row, col);
      return c !== null && (c.value !== null || c.formula !== undefined);
    },
    hidden: (axis, index) =>
      axis === 'rows' ? sheet.rows.isHidden(index) : sheet.cols.isHidden(index),
    lastUsed: () => {
      let row = 0;
      let col = 0;
      for (const c of sheet.cells.columnIndexes()) {
        col = Math.max(col, c);
        row = Math.max(row, sheet.cells.lastRowIn(c));
      }
      return { row, col };
    },
  };
}
