/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * How a value shows in a cell: its text under the cell's number format (the
 * Excel grammar of core/numfmt), the colour the format may ask for, and
 * where it sits when the style does not say.
 *
 * @module render/numberFormat
 */

import { compileFormat, EN_US, type NumberLocale } from '../core/numfmt.js';
import { type CellValue, isCellError } from '../core/values.js';

export type Align = 'left' | 'center' | 'right';

export interface Displayed {
  readonly text: string;
  /** Where the value sits when the style does not say. */
  readonly align: Align;
  readonly kind: 'number' | 'text' | 'boolean' | 'error' | 'empty';
  /** A colour the number format asks for (`[Red]`). */
  readonly color?: string;
}

/** Excel's General in a cell: at most 11 characters. */
export function general(n: number): string {
  return compileFormat('General')(n).text;
}

/** How a value shows under a format: its text, its colour, and its default alignment. */
export function display(
  value: CellValue,
  format = 'General',
  locale: NumberLocale = EN_US,
): Displayed {
  if (value === null) return { text: '', align: 'left', kind: 'empty' };
  if (typeof value === 'boolean')
    return { text: value ? 'TRUE' : 'FALSE', align: 'center', kind: 'boolean' };
  if (isCellError(value)) return { text: value.error, align: 'center', kind: 'error' };
  const shown = compileFormat(format, locale)(value);
  return {
    text: shown.text,
    color: shown.color,
    align: typeof value === 'string' ? 'left' : 'right',
    kind: typeof value === 'string' ? 'text' : 'number',
  };
}
