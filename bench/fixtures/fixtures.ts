/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The bench fixtures of the performance budgets, generated, never stored.
 * Each is deterministic (a seeded generator), so a figure measured today and
 * one measured next month ran on the same cells.
 *
 * A fixture is format-neutral: a size and a `cell(row, col)` function. The
 * loaders for Cells and for the reference spreadsheets read it the same way.
 */

/** A cell of a fixture: a number, a string, or a formula (A1, with `=`). */
export type FixtureCell = number | string | null;

export interface Fixture {
  /** Stable name, used as the prefix of every figure measured on it. */
  name: string;
  rows: number;
  cols: number;
  /** Cells that hold something, for "per cell" figures. */
  filled: number;
  cell(row: number, col: number): FixtureCell;
}

/** mulberry32: small, fast, and good enough to make values look like data. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value derived from the position only, so `cell` needs no stored table. */
function hash(row: number, col: number, seed: number): number {
  let h = (Math.imul(row, 0x9e3779b1) ^ Math.imul(col + seed, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliett',
  'kilo',
  'lima',
];

/** Column letters of a 0-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnName(col: number): string {
  let name = '';
  let n = col + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function numeric(name: string, rows: number, cols: number): Fixture {
  return {
    name,
    rows,
    cols,
    filled: rows * cols,
    cell: (row, col) => Math.round(hash(row, col, 1) * 1e6) / 100,
  };
}

/** Text, numbers and a few empty cells, mixed per column as real sheets are. */
function mixed(name: string, rows: number, cols: number): Fixture {
  let filled = 0;
  const cell = (row: number, col: number): FixtureCell => {
    const h = hash(row, col, 2);
    if (h < 0.05) return null;
    if (col % 3 === 0) return `${WORDS[Math.floor(h * WORDS.length)]} ${row}`;
    return Math.round(h * 1e5) / 100;
  };
  for (let row = 0; row < Math.min(rows, 1000); row += 1) {
    for (let col = 0; col < cols; col += 1) if (cell(row, col) !== null) filled += 1;
  }
  return { name, rows, cols, filled: Math.round((filled / Math.min(rows, 1000)) * rows), cell };
}

/**
 * Numbers in column A, and in B to J formulas over them: a running sum,
 * a product, a reference to the row above. Shapes repeat down each column,
 * as fills make them.
 */
function formulas(name: string, rows: number): Fixture {
  const cols = 10;
  return {
    name,
    rows,
    cols,
    filled: rows * cols,
    cell: (row, col) => {
      const r = row + 1;
      if (col === 0) return Math.round(hash(row, 0, 3) * 1e4) / 100;
      if (col === 1) return r === 1 ? '=A1' : `=B${r - 1}+A${r}`;
      if (col === 2) return `=A${r}*2`;
      if (col === 3) return `=IF(A${r}>50,A${r},0)`;
      return `=${columnName(col - 1)}${r}+1`;
    },
  };
}

/** Few rows, many columns: the horizontal axis's turn. */
function wide(name: string, rows: number, cols: number): Fixture {
  return {
    name,
    rows,
    cols,
    filled: rows * cols,
    cell: (row, col) => Math.round(hash(row, col, 4) * 1e4) / 100,
  };
}

/** Text in every cell: what the scroll-frame budget is measured on (text layout dominates a frame). */
function text(name: string, rows: number, cols: number): Fixture {
  return {
    name,
    rows,
    cols,
    filled: rows * cols,
    cell: (row, col) => `${WORDS[Math.floor(hash(row, col, 5) * WORDS.length)]} ${row + 1}`,
  };
}

/** Every fixture of the budgets (§ performance budgets), by name. */
export const FIXTURES = {
  numeric100k: numeric('numeric100k', 100_000, 10),
  numeric1m: numeric('numeric1m', 1_000_000, 10),
  mixed100k: mixed('mixed100k', 100_000, 10),
  formulas100k: formulas('formulas100k', 100_000),
  wide: wide('wide', 1_000, 1_000),
  text100k: text('text100k', 100_000, 26),
} as const satisfies Record<string, Fixture>;

export type FixtureName = keyof typeof FIXTURES;

/** The fixture of that name, or a refusal listing the names there are. */
export function fixture(name: string): Fixture {
  if (!(name in FIXTURES)) {
    throw new Error(`No fixture called '${name}'; there are ${Object.keys(FIXTURES).join(', ')}.`);
  }
  return FIXTURES[name as FixtureName];
}

/** The fixture as CSV text, rows `[from, to)`; what the reference loaders read. */
export function toCSV(f: Fixture, from = 0, to = f.rows): string {
  const lines: string[] = [];
  for (let row = from; row < to; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < f.cols; col += 1) {
      const value = f.cell(row, col);
      if (value === null) cells.push('');
      else if (typeof value === 'number') cells.push(String(value));
      else cells.push(/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}
