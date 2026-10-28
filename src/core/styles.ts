/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { checkFormatCode } from './numfmt.js';

/**
 * Cell styles, deduplicated by content into a table cells index with a
 * `Uint16`. The table only grows, so an index is stable for the life of the
 * workbook (undo and the file format rely on that); index 0 is the default.
 *
 * @module core/styles
 */

export type HorizontalAlign = 'left' | 'center' | 'right';
/** Where text sits in its cell's height. */
export type VerticalAlign = 'top' | 'middle' | 'bottom';
/** The line style of a cell border. */
export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';

/** One side of a cell's border: its style and colour. */
export interface BorderSide {
  readonly style: BorderStyle;
  readonly color: string;
}

/** A cell style: font, size, emphasis, colours, alignment, wrap, borders, number format and cell type. */
export interface Style {
  readonly font?: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  /** Text colour; absent means the theme's text colour. */
  readonly color?: string;
  readonly fill?: string;
  readonly align?: HorizontalAlign;
  readonly valign?: VerticalAlign;
  readonly wrap?: boolean;
  readonly borders?: {
    readonly top?: BorderSide;
    readonly right?: BorderSide;
    readonly bottom?: BorderSide;
    readonly left?: BorderSide;
  };
  /** An Excel number format, such as `#,##0.00` or `yyyy-mm-dd`. */
  readonly format?: string;
  /**
   * The cell type drawing and editing the cell (`checkbox`, `link`,
   * `progress`, or a plugin's), the id of a `datalayer.cells.cellType`
   * contribution. A type no plugin contributes draws as a plain value.
   */
  readonly type?: string;
}

const KEYS: readonly (keyof Style)[] = [
  'font',
  'size',
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'fill',
  'align',
  'valign',
  'wrap',
  'borders',
  'format',
  'type',
];
const KEY_SET: ReadonlySet<string> = new Set(KEYS);
const MAX_STYLES = 0xffff;

/** A canonical text for a style: its set keys in a fixed order, falsy flags dropped. */
function canonical(style: Style): string {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    const value = style[key];
    if (value === undefined || value === false) continue;
    out[key] = key === 'borders' ? canonicalBorders(value as Style['borders']) : value;
  }
  return JSON.stringify(out);
}

function canonicalBorders(b: Style['borders']): unknown {
  if (b === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) if (b[side]) out[side] = b[side];
  return out;
}

/** Throws a sentence naming the first thing wrong with a style. */
export function checkStyle(style: unknown, where = 'style'): asserts style is Style {
  if (typeof style !== 'object' || style === null || Array.isArray(style)) {
    throw new Error(`${where}: a style is an object.`);
  }
  for (const key of Object.keys(style)) {
    if (!KEY_SET.has(key))
      throw new Error(`${where}: '${key}' is not a style property (${KEYS.join(', ')}).`);
  }
  const s = style as Record<string, unknown>;
  for (const key of ['bold', 'italic', 'underline', 'strike', 'wrap']) {
    if (s[key] !== undefined && typeof s[key] !== 'boolean')
      throw new Error(`${where}.${key}: true or false.`);
  }
  for (const key of ['font', 'color', 'fill', 'format']) {
    if (s[key] !== undefined && typeof s[key] !== 'string')
      throw new Error(`${where}.${key}: a string.`);
  }
  if (s.type !== undefined && !(typeof s.type === 'string' && s.type !== ''))
    throw new Error(`${where}.type: the id of a cell type, a non-empty string.`);
  if (s.format !== undefined) {
    try {
      checkFormatCode(s.format as string);
    } catch (error) {
      throw new Error(`${where}.format: ${(error as Error).message}`);
    }
  }
  if (s.size !== undefined && !(typeof s.size === 'number' && s.size > 0)) {
    throw new Error(`${where}.size: a positive number.`);
  }
  if (s.align !== undefined && !['left', 'center', 'right'].includes(s.align as string)) {
    throw new Error(`${where}.align: left, center or right.`);
  }
  if (s.valign !== undefined && !['top', 'middle', 'bottom'].includes(s.valign as string)) {
    throw new Error(`${where}.valign: top, middle or bottom.`);
  }
}

export class StyleTable {
  #styles: Style[] = [{}];
  #index = new Map<string, number>([[canonical({}), 0]]);

  /** The index of a style, adding it when new. Index 0 is the default style. */
  intern(style: Style): number {
    const key = canonical(style);
    let i = this.#index.get(key);
    if (i === undefined) {
      if (this.#styles.length > MAX_STYLES) {
        throw new Error(`A workbook holds at most ${MAX_STYLES + 1} distinct styles.`);
      }
      i = this.#styles.length;
      this.#styles.push(JSON.parse(key) as Style);
      this.#index.set(key, i);
    }
    return i;
  }

  get(index: number): Style {
    const style = this.#styles[index];
    if (style === undefined)
      throw new Error(`No style ${index}; the workbook has ${this.#styles.length}.`);
    return style;
  }

  get size(): number {
    return this.#styles.length;
  }

  /** Every style, in index order (the file format's `styles`). */
  all(): readonly Style[] {
    return this.#styles;
  }
}
