/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The fill handle and sort, built in: the series rules (numbers, dates,
 * weekdays, months, text ending in a number, and copying as the last resort)
 * contributed to `datalayer.cells.fillRule`; the `FILL` and `SORT` commands;
 * and the Reactor commands Ctrl+D, Ctrl+R and sort, with their menu items.
 * Filled and sorted formulas have their relative references moved with them.
 *
 * @module builtins/fill
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import type { CellContent } from '../core/cells.js';
import { cellsPatch, type CommandContext, OK, refuse } from '../core/commands.js';
import { snapshot, snapshotEntries, snapshotOf } from '../core/patches.js';
import { type CellValue, isCellError } from '../core/values.js';
import { type Zone, zoneContains } from '../core/zone.js';
import { translateFormula } from '../formula/normal.js';
import type { CellsCommandArgument } from './editing.js';
import {
  CellsCommands,
  CellsFillRules,
  CellsMenuItems,
  CellsToolbarItems,
  type CommandHandler,
  type FillRule,
  type FillSource,
} from '../points/index.js';

/** The name of `CellsFillPlugin`. */
export const CELLS_FILL_PLUGIN = '@datalayer/cells-fill';

// ------------------------------------------------------------------ series rules

const isNumber = (v: CellValue): v is number => typeof v === 'number';
const DATE_FORMAT = /[dy]|m{3,}/i;

/** Numbers in a step (1, 3 → 5, 7); a single number is copied, as Excel does without Ctrl. */
const numbers: FillRule = {
  id: 'numbers',
  match: (src) => {
    if (src.length < 2 || !src.every((s) => isNumber(s.value))) return undefined;
    if (src.some((s) => s.format !== undefined && DATE_FORMAT.test(s.format))) return undefined;
    const values = src.map((s) => s.value as number);
    // The least-squares line through the source, as Excel's linear trend.
    const n = values.length;
    const mx = (n - 1) / 2;
    const my = values.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    values.forEach((y, x) => {
      num += (x - mx) * (y - my);
      den += (x - mx) ** 2;
    });
    const step = num / den;
    return { start: my - step * mx, step, n };
  },
  next: (series, index) => {
    const s = series as { start: number; step: number; n: number };
    // Forwards from past the source's end; backwards from before its start.
    const v = s.start + s.step * (index >= 0 ? s.n + index : index);
    return Math.round(v * 1e10) / 1e10;
  },
};

/** Dates (numbers with a date format) a day apart, or the step between two. */
const dates: FillRule = {
  id: 'dates',
  match: (src) => {
    if (
      src.length === 0 ||
      !src.every((s) => isNumber(s.value) && s.format !== undefined && DATE_FORMAT.test(s.format))
    )
      return undefined;
    const values = src.map((s) => s.value as number);
    const step = values.length >= 2 ? values[values.length - 1] - values[values.length - 2] : 1;
    return { last: values[values.length - 1], first: values[0], step };
  },
  next: (series, index) => {
    const s = series as { last: number; first: number; step: number };
    return index >= 0 ? s.last + s.step * (index + 1) : s.first + s.step * index;
  },
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Names in a cycle (Mon, Tue, … or January, February, …), keeping how the first was written. */
function cycleRule(id: string, names: readonly string[]): FillRule {
  const find = (text: string) => {
    const lower = text.toLowerCase();
    let i = names.findIndex((n) => n.toLowerCase() === lower);
    if (i >= 0) return { i, short: false };
    i = names.findIndex((n) => n.slice(0, 3).toLowerCase() === lower);
    return i >= 0 ? { i, short: true } : undefined;
  };
  return {
    id,
    match: (src) => {
      if (
        src.length === 0 ||
        !src.every((s) => typeof s.value === 'string' && find(s.value) !== undefined)
      )
        return undefined;
      const first = src[0].value as string;
      const found = src.map((s) => find(s.value as string)!);
      const step =
        found.length >= 2 ? (found[1].i - found[0].i + names.length) % names.length || 1 : 1;
      const upper = first === first.toUpperCase();
      const lower = first === first.toLowerCase();
      return {
        last: found[found.length - 1].i,
        first: found[0].i,
        step,
        short: found[0].short,
        upper,
        lower,
      };
    },
    next: (series, index) => {
      const s = series as {
        last: number;
        first: number;
        step: number;
        short: boolean;
        upper: boolean;
        lower: boolean;
      };
      const at = index >= 0 ? s.last + s.step * (index + 1) : s.first + s.step * index;
      const name = names[((at % names.length) + names.length) % names.length];
      const word = s.short ? name.slice(0, 3) : name;
      return s.upper ? word.toUpperCase() : s.lower ? word.toLowerCase() : word;
    },
  };
}

/** Text ending in a number (Item 1 → Item 2, Q3 → Q4). */
const numberedText: FillRule = {
  id: 'numberedText',
  match: (src) => {
    const parts = src.map((s) =>
      typeof s.value === 'string' ? /^(.*?)(\d+)$/.exec(s.value) : null,
    );
    if (src.length === 0 || parts.some((p) => p === null)) return undefined;
    const prefix = parts[0]![1];
    if (parts.some((p) => p![1] !== prefix)) return undefined;
    const ns = parts.map((p) => Number(p![2]));
    const step = ns.length >= 2 ? ns[ns.length - 1] - ns[ns.length - 2] : 1;
    return { prefix, last: ns[ns.length - 1], first: ns[0], step, width: parts[0]![2].length };
  },
  next: (series, index) => {
    const s = series as {
      prefix: string;
      last: number;
      first: number;
      step: number;
      width: number;
    };
    const n = index >= 0 ? s.last + s.step * (index + 1) : s.first + s.step * index;
    return `${s.prefix}${String(Math.abs(n)).padStart(s.width, '0')}`;
  },
};

/** The last resort: the source repeated. */
const copy: FillRule = {
  id: 'copy',
  match: (src) => (src.length > 0 ? src.map((s) => s.value) : undefined),
  next: (series, index) => {
    const values = series as CellValue[];
    return values[((index % values.length) + values.length) % values.length];
  },
};

/** The built-in fill-handle series rules, in the order they are tried: numbers, dates, weekdays, months, numbered text. */
export const FILL_RULES: readonly FillRule[] = [
  dates,
  numbers,
  cycleRule('weekdays', WEEKDAYS),
  cycleRule('months', MONTHS),
  numberedText,
  copy,
];

// ------------------------------------------------------------------ FILL

/** Extend a source zone over a target zone with the fill rules (or copy, with `copy: true`). */
export interface FillCommand {
  readonly type: 'FILL';
  readonly sheet: string;
  /** The cells dragged from. */
  readonly source: Zone;
  /** The zone the fill covers, source included: it extends the source down, up, right or left. */
  readonly target: Zone;
  /** `copy` repeats the source instead of extending a series (Ctrl while dragging). */
  readonly mode?: 'series' | 'copy';
}

function direction(source: Zone, target: Zone): 'down' | 'up' | 'right' | 'left' | undefined {
  const sameCols = source.left === target.left && source.right === target.right;
  const sameRows = source.top === target.top && source.bottom === target.bottom;
  if (sameCols && target.top === source.top && target.bottom > source.bottom) return 'down';
  if (sameCols && target.bottom === source.bottom && target.top < source.top) return 'up';
  if (sameRows && target.left === source.left && target.right > source.right) return 'right';
  if (sameRows && target.right === source.right && target.left < source.left) return 'left';
  return undefined;
}

const fillCommand: CommandHandler<FillCommand> = {
  type: 'FILL',
  allow: ({ workbook }, c) => {
    if (!workbook.hasSheet(c.sheet)) return refuse('UnknownSheet', `No sheet '${c.sheet}'.`);
    if (direction(c.source, c.target) === undefined) {
      return refuse(
        'InvalidArgument',
        'A fill extends its source down, up, right or left, by whole rows or columns of it.',
      );
    }
    const s = workbook.sheet(c.sheet);
    if (
      c.target.bottom >= s.rows.count ||
      c.target.right >= s.cols.count ||
      c.target.top < 0 ||
      c.target.left < 0
    ) {
      return refuse('OutOfBounds', 'The fill reaches past the end of the sheet.');
    }
    if (s.mergesIn(c.target).length > 0)
      return refuse(
        'MergeOverlap',
        'Filling across merged cells is not supported; unmerge them first.',
      );
    return OK;
  },
  apply: (context, c) => {
    const { workbook } = context;
    const s = workbook.sheet(c.sheet);
    const dir = direction(c.source, c.target)!;
    const vertical = dir === 'down' || dir === 'up';
    const rules = c.mode === 'copy' ? [copy] : context.contributions(CellsFillRules);
    const limits = { rows: s.rows.count, cols: s.cols.count };
    const contents: [number, number, CellContent | null][] = [];
    const lines = vertical ? [c.source.left, c.source.right] : [c.source.top, c.source.bottom];
    for (let line = lines[0]; line <= lines[1]; line += 1) {
      const at = (k: number) => (vertical ? { row: k, col: line } : { row: line, col: k });
      const [s0, s1] = vertical ? [c.source.top, c.source.bottom] : [c.source.left, c.source.right];
      const sourceCells = Array.from({ length: s1 - s0 + 1 }, (_, i) =>
        s.cells.get(at(s0 + i).row, at(s0 + i).col),
      );
      const src: FillSource[] = sourceCells.map((cell) => ({
        value: cell?.value ?? null,
        format: cell ? workbook.styles.get(cell.style).format : undefined,
      }));
      const hasFormula = sourceCells.some((cell) => cell?.formula !== undefined);
      let rule: FillRule | undefined;
      let series: unknown;
      if (!hasFormula) {
        for (const r of rules) {
          series = r.match(src);
          if (series !== undefined) {
            rule = r;
            break;
          }
        }
      }
      const [t0, t1] = vertical ? [c.target.top, c.target.bottom] : [c.target.left, c.target.right];
      const forward = dir === 'down' || dir === 'right';
      const span = s1 - s0 + 1;
      for (let k = t0; k <= t1; k += 1) {
        if (k >= s0 && k <= s1) continue;
        const index = forward ? k - s1 - 1 : k - s0;
        const offset = ((index % span) + span) % span;
        const from = sourceCells[offset];
        const style = from?.style ?? 0;
        const p = at(k);
        if (from?.formula !== undefined) {
          // A formula's relative references move with it.
          const o = at(s0 + offset);
          const formula = translateFormula(from.formula, p.row - o.row, p.col - o.col, limits);
          contents.push([p.row, p.col, { value: null, formula, style }]);
        } else if (hasFormula || rule === undefined) {
          // What no rule extends (and values beside formulas) is copied as it is.
          contents.push([p.row, p.col, from === null ? null : { ...from, style }]);
        } else {
          const value = rule.next(series, index);
          contents.push([p.row, p.col, value === null && style === 0 ? null : { value, style }]);
        }
      }
    }
    return [cellsPatch(s, c.target, contents)];
  },
};

// ------------------------------------------------------------------ SORT

/** Sort a zone's rows by one or more columns. */
export interface SortCommand {
  readonly type: 'SORT';
  readonly sheet: string;
  readonly zone: Zone;
  /** Columns to sort by, first key first. */
  readonly keys: readonly { readonly col: number; readonly descending?: boolean }[];
  /** The zone's first row is a header and stays. */
  readonly header?: boolean;
}

/** Excel's order: numbers, text (case-insensitive), booleans, errors; empty cells always last. */
function rank(v: CellValue): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  if (isCellError(v)) return 3;
  return 4;
}

function compareValues(a: CellValue, b: CellValue): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) - (b as number);
  if (ra === 1)
    return (a as string).localeCompare(b as string, undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  if (ra === 2) return Number(a) - Number(b);
  return 0;
}

const sortCommand: CommandHandler<SortCommand> = {
  type: 'SORT',
  allow: ({ workbook }, c) => {
    if (!workbook.hasSheet(c.sheet)) return refuse('UnknownSheet', `No sheet '${c.sheet}'.`);
    if (c.keys.length === 0)
      return refuse('InvalidArgument', 'A sort needs at least one key column.');
    if (c.keys.some((k) => k.col < c.zone.left || k.col > c.zone.right))
      return refuse('InvalidArgument', 'A sort key lies outside the zone sorted.');
    const s = workbook.sheet(c.sheet);
    if (s.mergesIn(c.zone).length > 0)
      return refuse(
        'MergeOverlap',
        'Sorting across merged cells is not supported; unmerge them first.',
      );
    return OK;
  },
  apply: ({ workbook, value: shown }, c) => {
    const s = workbook.sheet(c.sheet);
    const limits = { rows: s.rows.count, cols: s.cols.count };
    const body: Zone = { ...c.zone, top: c.zone.top + (c.header ? 1 : 0) };
    if (body.top > body.bottom) return [];
    // Only the rows holding something move; empty rows sink below them.
    const byRow = new Map<number, [number, CellContent][]>();
    for (const [row, col, content] of snapshotEntries(snapshot(s, body))) {
      if (!byRow.has(row)) byRow.set(row, []);
      byRow.get(row)!.push([col, content]);
    }
    const value = (row: number, col: number) => {
      const cell = byRow.get(row)?.find(([c2]) => c2 === col)?.[1];
      if (cell === undefined) return null;
      return cell.formula === undefined ? cell.value : shown(c.sheet, row, col);
    };
    const rows = [...byRow.keys()].sort((a, b) => {
      for (const key of c.keys) {
        const va = value(a, key.col);
        const vb = value(b, key.col);
        // Empty cells stay last whichever the direction.
        if (va === null || vb === null) {
          if (va === vb) continue;
          return va === null ? 1 : -1;
        }
        const d = compareValues(va, vb);
        if (d !== 0) return key.descending ? -d : d;
      }
      return a - b; // stable
    });
    const moved: [number, number, CellContent][] = [];
    rows.forEach((from, i) => {
      const to = body.top + i;
      for (const [col, content] of byRow.get(from)!) {
        // A formula moved to another row keeps pointing at its own row's cells.
        moved.push([
          to,
          col,
          content.formula === undefined || to === from
            ? content
            : { ...content, formula: translateFormula(content.formula, to - from, 0, limits) },
        ]);
      }
    });
    const before = snapshot(s, body);
    const after = snapshotOf(moved);
    return [{ op: 'cells', sheet: c.sheet, zone: body, before, after } as never];
  },
};

// ------------------------------------------------------------------ Reactor commands

function fillAction(dir: 'down' | 'right') {
  return ({ model: m }: CellsCommandArgument) => {
    const z = m.selection.zones[m.selection.zones.length - 1];
    const single = z.top === z.bottom && z.left === z.right;
    // Ctrl+D with one cell copies the cell above; with a range, the range's first row (Ctrl+R: column).
    const target: Zone = single
      ? dir === 'down'
        ? { ...z, top: Math.max(0, z.top - 1) }
        : { ...z, left: Math.max(0, z.left - 1) }
      : z;
    if (target.top === target.bottom && target.left === target.right) return { ok: true } as const;
    const source: Zone =
      dir === 'down' ? { ...target, bottom: target.top } : { ...target, right: target.left };
    const result = m.dispatch({
      type: 'FILL',
      sheet: m.selection.sheet,
      source,
      target,
      mode: 'copy',
    });
    if (!result.ok) throw new Error(result.refusals.map((r) => r.message).join(' '));
    return result;
  };
}

function sortAction(descending: boolean) {
  return ({ model: m }: CellsCommandArgument) => {
    const z = m.selection.zones[m.selection.zones.length - 1];
    const sheet = m.sheet(m.selection.sheet);
    // One cell selected: the block of data around it is sorted, as Excel does.
    let zone = z;
    if (z.top === z.bottom && z.left === z.right) {
      let bottom = z.top;
      while (bottom + 1 < sheet.rows.count && sheet.cells.get(bottom + 1, z.left) !== null)
        bottom += 1;
      zone = { top: z.top, bottom, left: 0, right: Math.max(...[...sheet.cells.columnIndexes()]) };
    }
    const col = zoneContains(zone, m.selection.active) ? m.selection.active.col : zone.left;
    const result = m.dispatch({ type: 'SORT', sheet: sheet.id, zone, keys: [{ col, descending }] });
    if (!result.ok) throw new Error(result.refusals.map((r) => r.message).join(' '));
    return result;
  };
}

/** The built-in fill rules and the `FILL` and `SORT` commands, with their toolbar and menu items. */
export const CellsFillPlugin = definePlugin({
  name: CELLS_FILL_PLUGIN,
  displayName: 'Cells fill and sort',
  description: "The fill handle's series, Ctrl+D and Ctrl+R, and sorting.",
  octicon: 'sort-asc',
  commands: [
    {
      id: 'cells.fillDown',
      name: 'Fill down',
      category: 'Cells',
      keybinding: 'Mod+D',
      execute: fillAction('down'),
    },
    {
      id: 'cells.fillRight',
      name: 'Fill right',
      category: 'Cells',
      keybinding: 'Mod+R',
      execute: fillAction('right'),
    },
    {
      id: 'cells.sortAscending',
      name: 'Sort A to Z',
      category: 'Cells',
      octicon: 'sort-asc',
      execute: sortAction(false),
    },
    {
      id: 'cells.sortDescending',
      name: 'Sort Z to A',
      category: 'Cells',
      octicon: 'sort-desc',
      execute: sortAction(true),
    },
  ],
  contributes: [
    ...FILL_RULES.map((rule, i) =>
      contribution(CellsFillRules, rule, { id: rule.id, order: 100 + i }),
    ),
    contribution(CellsCommands, fillCommand, { id: 'FILL', order: 100 }),
    contribution(CellsCommands, sortCommand, { id: 'SORT', order: 100 }),
    contribution(
      CellsMenuItems,
      { command: 'cells.fillDown', group: 'fill' },
      { id: 'cells.fillDown', order: 150 },
    ),
    contribution(
      CellsMenuItems,
      { command: 'cells.fillRight', group: 'fill' },
      { id: 'cells.fillRight', order: 151 },
    ),
    contribution(
      CellsMenuItems,
      { command: 'cells.sortAscending', group: 'sort' },
      { id: 'cells.sortAscending', order: 160 },
    ),
    contribution(
      CellsMenuItems,
      { command: 'cells.sortDescending', group: 'sort' },
      { id: 'cells.sortDescending', order: 161 },
    ),
    contribution(
      CellsToolbarItems,
      { command: 'cells.sortAscending', group: 'sort' },
      { id: 'cells.sortAscending', order: 160 },
    ),
    contribution(
      CellsToolbarItems,
      { command: 'cells.sortDescending', group: 'sort' },
      { id: 'cells.sortDescending', order: 161 },
    ),
  ],
});
