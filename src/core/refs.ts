/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * References as people write them (`B3`, `Sheet2!A1:C4`, `'My sheet'!B2`),
 * resolved against a model: the sheet by name, else the selection's sheet.
 *
 * @module core/refs
 */

import type { CellsModel } from './model.js';
import { parseA1, parseZone, type Position, splitSheet, type Zone } from './zone.js';

export interface ResolvedCell extends Position {
  readonly sheet: string;
}

export interface ResolvedRange {
  readonly sheet: string;
  readonly zone: Zone;
}

function sheetOf(model: CellsModel, name: string | undefined, ref: string): string {
  if (name === undefined) return model.selection.sheet;
  const lower = name.toLowerCase();
  const sheet = model.sheets.find((s) => s.name.toLowerCase() === lower);
  if (sheet === undefined)
    throw new Error(`'${ref}' names no sheet of the workbook: there is no '${name}'.`);
  return sheet.id;
}

/** The sheet and position of `Sheet1!B3` or `B3`. */
export function resolveCell(model: CellsModel, ref: string): ResolvedCell {
  const { sheet, ref: a1 } = splitSheet(ref);
  return { sheet: sheetOf(model, sheet, ref), ...parseA1(a1) };
}

/** The sheet and zone of `Sheet1!A1:C4`, `B3`, `A1:B2`. */
export function resolveRange(model: CellsModel, ref: string): ResolvedRange {
  const { sheet, ref: a1 } = splitSheet(ref);
  return { sheet: sheetOf(model, sheet, ref), zone: parseZone(a1) };
}
