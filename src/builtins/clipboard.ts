/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The built-in clipboard: a handler per feature (cells, merges, column and
 * row sizes) contributed to `datalayer.cells.clipboard`, and the `PASTE`
 * command that hands a slice to every handler. A plugin's own handler joins
 * the same point and travels with the cells.
 *
 * @module builtins/clipboard
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import {
  allowPaste,
  copyCells,
  type PasteCommand,
  type PasteOptions,
  pastedSize,
  pasteCells,
  type SliceCell,
  zoneOfPaste,
} from '../core/clipboard.js';
import type { Patch } from '../core/patches.js';
import type { Zone } from '../core/zone.js';
import {
  CellsClipboard,
  CellsCommands,
  type ClipboardHandler,
  type CommandHandler,
} from '../points/index.js';

/** The name of `CellsClipboardPlugin`. */
export const CELLS_CLIPBOARD_PLUGIN = '@datalayer/cells-clipboard';

const cellsHandler: ClipboardHandler = {
  id: 'cells',
  copy: (context, sheet, zone) => copyCells(context, sheet, zone),
  paste: (context, sheet, part, target, options, source) => [
    pasteCells(context, sheet, part as SliceCell[], target, options, source),
  ],
};

/** Merges wholly inside the copied zone travel with it; merges wholly inside the target are replaced. */
const mergesHandler: ClipboardHandler = {
  id: 'merges',
  copy: (context, sheet, zone) => {
    const inside = context.workbook
      .sheet(sheet)
      .mergesIn(zone)
      .filter(
        (m) =>
          m.top >= zone.top &&
          m.bottom <= zone.bottom &&
          m.left >= zone.left &&
          m.right <= zone.right,
      )
      .map((m) => ({
        top: m.top - zone.top,
        left: m.left - zone.left,
        bottom: m.bottom - zone.top,
        right: m.right - zone.left,
      }));
    return inside.length > 0 ? inside : undefined;
  },
  paste: (context, sheet, part, target, options) => {
    if (options.special === 'values' || options.special === 'formulas') return [];
    const s = context.workbook.sheet(sheet);
    const t = (z: Zone): Zone =>
      options.transpose
        ? {
            top: target.top + z.left,
            left: target.left + z.top,
            bottom: target.top + z.right,
            right: target.left + z.bottom,
          }
        : {
            top: target.top + z.top,
            left: target.left + z.left,
            bottom: target.top + z.bottom,
            right: target.left + z.right,
          };
    const kept = s.merges.filter(
      (m) =>
        !(
          m.top >= target.top &&
          m.bottom <= target.bottom &&
          m.left >= target.left &&
          m.right <= target.right
        ),
    );
    const after = [...kept, ...((part as Zone[] | undefined) ?? []).map(t)];
    if (JSON.stringify(after) === JSON.stringify(s.merges)) return [];
    return [{ op: 'merges', sheet, before: s.merges, after } as Patch];
  },
};

/** Whole columns copied bring their widths; whole rows their heights. */
const sizesHandler: ClipboardHandler = {
  id: 'sizes',
  copy: (context, sheet, zone) => {
    const s = context.workbook.sheet(sheet);
    if (zone.top === 0 && zone.bottom === s.rows.count - 1) {
      return {
        axis: 'cols',
        sizes: Array.from({ length: zone.right - zone.left + 1 }, (_, k) =>
          s.cols.sizeOf(zone.left + k),
        ),
      };
    }
    if (zone.left === 0 && zone.right === s.cols.count - 1) {
      return {
        axis: 'rows',
        sizes: Array.from({ length: zone.bottom - zone.top + 1 }, (_, k) =>
          s.rows.sizeOf(zone.top + k),
        ),
      };
    }
    return undefined;
  },
  paste: (context, sheet, part, target, options) => {
    if (
      part === undefined ||
      options.special === 'values' ||
      options.special === 'formulas' ||
      options.transpose
    )
      return [];
    const { axis, sizes } = part as { axis: 'rows' | 'cols'; sizes: number[] };
    const s = context.workbook.sheet(sheet);
    const a = axis === 'rows' ? s.rows : s.cols;
    const at = axis === 'rows' ? target.top : target.left;
    const n = Math.min(sizes.length, a.count - at);
    const before = {
      sizes: Float64Array.from({ length: n }, (_, k) => a.sizeOf(at + k)),
      hidden: Uint8Array.from({ length: n }, (_, k) => (a.isHidden(at + k) ? 1 : 0)),
    };
    const after = { sizes: Float64Array.from(sizes.slice(0, n)), hidden: before.hidden };
    return [{ op: 'axis-sizes', sheet, axis, at, n, before, after } as Patch];
  },
};

/** `PASTE`: every clipboard handler pastes its part of the slice, in the handlers' order. */
const pasteCommand: CommandHandler<PasteCommand> = {
  type: 'PASTE',
  allow: (context, c) => allowPaste(context, c),
  apply: (context, c) => {
    const options: PasteOptions = c.options ?? {};
    const target = zoneOfPaste(c.at, pastedSize(c.slice, options));
    const patches: Patch[] = [];
    for (const handler of context.contributions(CellsClipboard)) {
      if (!(handler.id in c.slice.parts)) continue;
      patches.push(
        ...handler.paste(
          context,
          c.sheet,
          c.slice.parts[handler.id],
          target,
          options,
          c.slice.source,
        ),
      );
    }
    return patches;
  },
};

/** The built-in clipboard handlers (cells, merges, sizes) and the `PASTE` command, through `datalayer.cells.clipboard`. */
export const CellsClipboardPlugin = definePlugin({
  name: CELLS_CLIPBOARD_PLUGIN,
  displayName: 'Cells clipboard',
  description: 'Copy and paste of cells, merges and sizes, and the PASTE command.',
  octicon: 'paste',
  contributes: [
    contribution(CellsClipboard, cellsHandler, { id: 'cells', order: 100 }),
    contribution(CellsClipboard, mergesHandler, { id: 'merges', order: 110 }),
    contribution(CellsClipboard, sizesHandler, { id: 'sizes', order: 120 }),
    contribution(CellsCommands, pasteCommand, { id: 'PASTE', order: 100 }),
  ],
});
