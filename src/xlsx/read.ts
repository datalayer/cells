/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The XLSX reader: the package unzipped (fflate), its parts scanned
 * (`xml.ts`), extracted, and converted into a `CellsWorkbook`, written from
 * ECMA-376. 1.0 reads values and shared strings, formulas (shared ones
 * expanded cell by cell), styles (fonts, fills, borders, alignment, wrap,
 * number formats, built-in ids included), merges, column widths and row
 * heights, hidden rows and columns, frozen panes and several sheets. What
 * it meets and leaves out (charts, images, comments, conditional formats,
 * data validation, defined names…) goes in the import report.
 *
 * @module xlsx/read
 */

import { strFromU8, unzipSync } from 'fflate';
import type { CellsCell, CellsSheet, CellsWorkbook, JsonValue } from '../core/format.js';
import type { BorderSide, BorderStyle, Style } from '../core/styles.js';
import { isErrorCode } from '../core/values.js';
import type { Zone } from '../core/zone.js';
import { translateFormula } from '../formula/normal.js';
import { BUILTIN_FORMATS } from './formats.js';
import { type Attributes, decode, scan } from './xml.js';

/** What an import met and left out, and what it changed, for the person who opened the file. */
export interface ImportReport {
  readonly sheets: number;
  readonly cells: number;
  readonly formulas: number;
  /** Features of the file 1.0 does not read, each with how many there were. */
  readonly skipped: readonly { readonly feature: string; readonly count: number }[];
}

/** Column letters to an index: `A` is 0. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** `B3` as row 2, column 1. */
function cellRef(ref: string): { row: number; col: number } {
  const m = /^\$?([A-Z]{1,3})\$?([0-9]+)$/.exec(ref);
  if (m === null) throw new Error(`'${ref}' is not a cell reference.`);
  return { row: Number(m[2]) - 1, col: columnIndex(m[1]) };
}

function zoneRef(ref: string): Zone {
  const [a, b = a] = ref.split(':');
  const from = cellRef(a);
  const to = cellRef(b);
  return {
    top: Math.min(from.row, to.row),
    left: Math.min(from.col, to.col),
    bottom: Math.max(from.row, to.row),
    right: Math.max(from.col, to.col),
  };
}

/** A colour attribute (`rgb="FF0000FF"`, ARGB) as `#rrggbb`; theme and indexed colours are not read. */
function color(a: Attributes | undefined): string | undefined {
  const rgb = a?.rgb;
  if (rgb === undefined || !/^[0-9A-Fa-f]{6,8}$/.test(rgb)) return undefined;
  return `#${rgb.slice(-6).toLowerCase()}`;
}

const BORDER_STYLES: Record<string, BorderStyle> = {
  thin: 'thin',
  hair: 'thin',
  medium: 'medium',
  thick: 'thick',
  dashed: 'dashed',
  mediumDashed: 'dashed',
  dashDot: 'dashed',
  mediumDashDot: 'dashed',
  dashDotDot: 'dotted',
  mediumDashDotDot: 'dotted',
  slantDashDot: 'dashed',
  dotted: 'dotted',
  double: 'double',
};

interface Font {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  color?: string;
  font?: string;
}

/** The styles part: each cell format (`xf`) as a `Style`. */
function readStyles(xml: string | undefined): Style[] {
  if (xml === undefined) return [{}];
  const numFmts = new Map<number, string>();
  const fonts: Font[] = [];
  const fills: (string | undefined)[] = [];
  const borders: Style['borders'][] = [];
  const xfs: Style[] = [];
  const fontOf = new Map<Style, Font>();
  let section = '';
  let font: Font | undefined;
  let fill: { pattern?: string; color?: string } | undefined;
  let border: Record<string, BorderSide> | undefined;
  let side: { name: string; style?: BorderStyle } | undefined;
  let xf: Style | undefined;
  let xfFont: Font | undefined;
  scan(xml, {
    open(name, a) {
      switch (name) {
        case 'numFmts':
        case 'fonts':
        case 'fills':
        case 'borders':
        case 'cellXfs':
        case 'cellStyleXfs':
        case 'dxfs':
          section = name;
          return;
        case 'numFmt':
          if (section === 'numFmts') numFmts.set(Number(a.numFmtId), a.formatCode ?? 'General');
          return;
      }
      if (section === 'fonts') {
        if (name === 'font') font = {};
        else if (font !== undefined) {
          if (name === 'b') font.bold = a.val !== '0' && a.val !== 'false';
          else if (name === 'i') font.italic = a.val !== '0' && a.val !== 'false';
          else if (name === 'u') font.underline = a.val !== 'none';
          else if (name === 'strike') font.strike = a.val !== '0' && a.val !== 'false';
          else if (name === 'sz') font.size = Number(a.val);
          else if (name === 'color') font.color = color(a);
          else if (name === 'name') font.font = a.val;
        }
      } else if (section === 'fills') {
        if (name === 'fill') fill = {};
        else if (name === 'patternFill' && fill) fill.pattern = a.patternType;
        else if (name === 'fgColor' && fill) fill.color = color(a);
      } else if (section === 'borders') {
        if (name === 'border') border = {};
        else if (border !== undefined && ['left', 'right', 'top', 'bottom'].includes(name))
          side = { name, style: a.style === undefined ? undefined : BORDER_STYLES[a.style] };
        else if (name === 'color' && side !== undefined && side.style !== undefined)
          border![side.name] = { style: side.style, color: color(a) ?? '#000000' };
      } else if (section === 'cellXfs') {
        if (name === 'xf') {
          const id = Number(a.numFmtId ?? 0);
          const f = fonts[Number(a.fontId ?? 0)] ?? {};
          xfFont = f;
          const fillColor = fills[Number(a.fillId ?? 0)];
          const b = borders[Number(a.borderId ?? 0)];
          // An en-US locale tag (`[$-409]`, `[$-en-US]`) says what the default says already.
          const format =
            id === 0
              ? undefined
              : (numFmts.get(id) ?? BUILTIN_FORMATS[id])?.replace(/^\[\$-(409|en-US)\]/, '');
          xf = {
            ...(f.bold ? { bold: true } : {}),
            ...(f.italic ? { italic: true } : {}),
            ...(f.underline ? { underline: true } : {}),
            ...(f.strike ? { strike: true } : {}),
            ...(f.color !== undefined && f.color !== '#000000' ? { color: f.color } : {}),
            ...(fillColor !== undefined ? { fill: fillColor } : {}),
            ...(b !== undefined && Object.keys(b).length > 0 ? { borders: b } : {}),
            ...(format !== undefined && format !== 'General' ? { format } : {}),
          };
        } else if (name === 'alignment' && xf !== undefined) {
          const h = a.horizontal;
          const v = a.vertical;
          xf = {
            ...xf,
            ...(h === 'left' || h === 'center' || h === 'right' ? { align: h } : {}),
            ...(v === 'top' ? { valign: 'top' } : v === 'center' ? { valign: 'middle' } : {}),
            ...(a.wrapText === '1' || a.wrapText === 'true' ? { wrap: true } : {}),
          };
        }
      }
    },
    close(name) {
      if (name === section) section = '';
      else if (name === 'font' && font !== undefined) {
        fonts.push(font);
        font = undefined;
      } else if (name === 'fill' && fill !== undefined) {
        fills.push(fill.pattern === 'solid' ? fill.color : undefined);
        fill = undefined;
      } else if (name === 'border' && border !== undefined) {
        borders.push(border as Style['borders']);
        border = undefined;
      } else if (['left', 'right', 'top', 'bottom'].includes(name)) side = undefined;
      else if (name === 'xf' && xf !== undefined && section === 'cellXfs') {
        xfs.push(xf);
        if (xfFont !== undefined) fontOf.set(xf, xfFont);
        xf = undefined;
      }
    },
  });
  // Style 0 is the default; the default font's size and face are the sheet's, so only
  // other sizes and faces are kept.
  const base = fonts[0] ?? {};
  return xfs.map((s, i) => {
    if (i === 0) return {};
    const f = fontOf.get(s);
    if (f === undefined) return s;
    return {
      ...s,
      ...(f.size !== undefined && f.size !== base.size ? { size: f.size } : {}),
      ...(f.font !== undefined && f.font !== base.font ? { font: f.font } : {}),
    };
  });
}

/** Shared strings: plain or rich (`r` runs), as plain text. */
function readSharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (xml === undefined) return out;
  let current: string | undefined;
  let inText = false;
  let inPhonetic = false;
  scan(xml, {
    open(name) {
      if (name === 'si') current = '';
      else if (name === 't') inText = !inPhonetic;
      else if (name === 'rPh') inPhonetic = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(current ?? '');
        current = undefined;
      } else if (name === 't') inText = false;
      else if (name === 'rPh') inPhonetic = false;
    },
    text(t) {
      if (inText && current !== undefined) current += t;
    },
  });
  return out;
}

/** Column widths are in characters of the default font (Calibri 11: 7 px each, plus 5 of padding). */
const widthPx = (chars: number) => Math.round(chars * 7 + 5);
/** Row heights are in points. */
const heightPx = (points: number) => Math.round((points * 4) / 3);

interface SheetResult {
  sheet: Omit<CellsSheet, 'id' | 'name'>;
  cells: number;
  formulas: number;
}

function readSheet(xml: string, strings: string[], skipped: Map<string, number>): SheetResult {
  const rows: Record<string, { cells: Record<string, CellsCell> }> = {};
  const rowSizes: Record<string, number> = {};
  const colSizes: Record<string, number> = {};
  const hiddenRows: number[] = [];
  const hiddenCols: number[] = [];
  const merges: Zone[] = [];
  let frozen: { rows: number; cols: number } | undefined;
  const shared = new Map<string, { formula: string; row: number; col: number }>();
  let cells = 0;
  let formulas = 0;
  // The cell being read.
  let at: { row: number; col: number } | undefined;
  let type = 'n';
  let style = 0;
  let value: string | undefined;
  let formula: string | undefined;
  let formulaAttributes: Attributes | undefined;
  let inline = '';
  let reading: 'v' | 'f' | 'is' | undefined;
  let nextRow = 0;
  let nextCol = 0;

  /** A cell read: its value by type, its formula (shared ones moved from their first cell), its style. */
  const finish = (
    at: { row: number; col: number },
    type: string,
    style: number,
    value: string | undefined,
    formula: string | undefined,
    fa: Attributes | undefined,
    inline: string,
  ): void => {
    const cell: { v?: JsonValue; f?: string; s?: number } = {};
    // Formulas: shared ones are written once, at their first cell, and moved for the others.
    if (fa?.t === 'shared' && fa.si !== undefined) {
      if (formula !== undefined && formula !== '') shared.set(fa.si, { formula, ...at });
      else {
        const master = shared.get(fa.si);
        if (master !== undefined)
          formula = translateFormula(master.formula, at.row - master.row, at.col - master.col);
      }
    } else if (fa?.t === 'array')
      skipped.set('array formula', (skipped.get('array formula') ?? 0) + 1);
    if (formula !== undefined && formula !== '') {
      cell.f = formula;
      formulas += 1;
    }
    if (type === 's' && value !== undefined) cell.v = strings[Number(value)] ?? '';
    else if (type === 'b' && value !== undefined) cell.v = value === '1';
    else if (type === 'e' && value !== undefined)
      cell.v = isErrorCode(value) ? { error: value } : { error: '#VALUE!' };
    else if ((type === 'str' || type === 'inlineStr') && (value !== undefined || inline !== ''))
      cell.v = type === 'inlineStr' ? inline : (value ?? '');
    else if (value !== undefined && value !== '') cell.v = Number(value);
    if (style !== 0) cell.s = style;
    if (cell.v !== undefined || cell.f !== undefined || cell.s !== undefined) {
      const key = String(at.row);
      (rows[key] ??= { cells: {} }).cells[String(at.col)] = cell;
      cells += 1;
    }
  };

  /** Rows and cells of `sheetData` whose cells all say where they are (`r`), as Excel and LibreOffice write them. */
  const readCells = (data: string): void => {
    const ROW = /<(?:\w+:)?row\s([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = ROW.exec(data)) !== null) {
      const a = m[1];
      const r = /\br="(\d+)"/.exec(a);
      if (r === null) continue;
      const row = Number(r[1]) - 1;
      const ht = /\bht="([^"]+)"/.exec(a);
      if (ht !== null && /\bcustomHeight="(1|true)"/.test(a))
        rowSizes[String(row)] = heightPx(Number(ht[1]));
      if (/\bhidden="(1|true)"/.test(a)) hiddenRows.push(row);
    }
    const CELL = /<(?:\w+:)?c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    while ((m = CELL.exec(data)) !== null) {
      const a = m[1];
      const inner = m[2] ?? '';
      const at = cellRef(/\br="([^"]+)"/.exec(a)![1]);
      const type = /\bt="([^"]+)"/.exec(a)?.[1] ?? 'n';
      const style = Number(/\bs="(\d+)"/.exec(a)?.[1] ?? 0);
      let value: string | undefined;
      let formula: string | undefined;
      let fa: Attributes | undefined;
      let inline = '';
      if (inner !== '') {
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        if (v !== null) value = decode(v[1]);
        else if (/<(?:\w+:)?v\/>/.test(inner)) value = '';
        const f = /<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(inner);
        if (f !== null) {
          fa = {};
          for (const [, k, x] of f[1].matchAll(/(\w+)="([^"]*)"/g)) fa[k] = x;
          formula = decode(f[2] ?? '');
        }
        if (type === 'inlineStr')
          for (const [, t] of inner.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g))
            inline += decode(t);
      }
      finish(at, type, style, value, formula, fa, inline);
    }
  };

  // The cells, by a path made for them (a sheet is mostly cells); the rest of the part by the scanner.
  let rest = xml;
  const open = /<(?:\w+:)?sheetData\b[^>]*>/.exec(xml);
  const close = open === null ? -1 : xml.search(/<\/(?:\w+:)?sheetData>/);
  if (open !== null && close > open.index && !/<(?:\w+:)?c(?=[\s>/])(?![^>]*\sr=)/.test(xml)) {
    readCells(xml.slice(open.index + open[0].length, close));
    rest = xml.slice(0, open.index) + xml.slice(close);
  }
  scan(rest, {
    open(name, a) {
      switch (name) {
        case 'row': {
          const r = a.r === undefined ? nextRow : Number(a.r) - 1;
          nextRow = r + 1;
          nextCol = 0;
          if (a.ht !== undefined && (a.customHeight === '1' || a.customHeight === 'true'))
            rowSizes[String(r)] = heightPx(Number(a.ht));
          if (a.hidden === '1' || a.hidden === 'true') hiddenRows.push(r);
          return;
        }
        case 'c': {
          at = a.r === undefined ? { row: nextRow - 1, col: nextCol } : cellRef(a.r);
          nextCol = at.col + 1;
          type = a.t ?? 'n';
          style = Number(a.s ?? 0);
          value = undefined;
          formula = undefined;
          formulaAttributes = undefined;
          inline = '';
          return;
        }
        case 'v':
          reading = 'v';
          value = '';
          return;
        case 'f':
          reading = 'f';
          formula = '';
          formulaAttributes = a;
          return;
        case 'is':
          reading = 'is';
          return;
        case 'col': {
          const min = Number(a.min) - 1;
          const max = Math.min(Number(a.max) - 1, 16_383);
          for (let c = min; c <= max; c += 1) {
            if (a.width !== undefined && (a.customWidth === '1' || a.customWidth === 'true'))
              colSizes[String(c)] = widthPx(Number(a.width));
            if (a.hidden === '1' || a.hidden === 'true') hiddenCols.push(c);
          }
          return;
        }
        case 'mergeCell':
          if (a.ref !== undefined) merges.push(zoneRef(a.ref));
          return;
        case 'pane':
          if (a.state === 'frozen' || a.state === 'frozenSplit')
            frozen = { rows: Number(a.ySplit ?? 0), cols: Number(a.xSplit ?? 0) };
          return;
        case 'conditionalFormatting':
        case 'dataValidation':
        case 'hyperlink':
        case 'drawing':
        case 'legacyDrawing':
        case 'tablePart':
        case 'sheetProtection':
        case 'autoFilter':
          skipped.set(name, (skipped.get(name) ?? 0) + 1);
          return;
      }
    },
    text(t) {
      if (reading === 'v') value += t;
      else if (reading === 'f') formula += t;
      else if (reading === 'is') inline += t;
    },
    close(name) {
      if (name === 'v' || name === 'f' || name === 'is') {
        reading = undefined;
        return;
      }
      if (name !== 'c' || at === undefined) return;
      finish(at, type, style, value, formula, formulaAttributes, inline);
      at = undefined;
    },
  });
  return {
    sheet: {
      rows,
      ...(Object.keys(rowSizes).length + Object.keys(colSizes).length > 0
        ? { sizes: { rows: rowSizes, cols: colSizes } }
        : {}),
      ...(hiddenRows.length + hiddenCols.length > 0
        ? { hidden: { rows: hiddenRows, cols: hiddenCols } }
        : {}),
      ...(merges.length > 0 ? { merges } : {}),
      ...(frozen !== undefined ? { frozen } : {}),
    },
    cells,
    formulas,
  };
}

/** A part's path from a relationship target, relative to `xl/`. */
function partPath(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `xl/${target}`.replace(/\/[^/]+\/\.\.\//g, '/');
}

/** Read an XLSX file into a workbook, and what was left out. */
export function readXlsx(bytes: Uint8Array): { workbook: CellsWorkbook; report: ImportReport } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`The file is not an XLSX package: ${(error as Error).message}`);
  }
  const text = (path: string) => (files[path] === undefined ? undefined : strFromU8(files[path]));
  const workbookXml = text('xl/workbook.xml');
  if (workbookXml === undefined) throw new Error('The package has no xl/workbook.xml.');
  const targets = new Map<string, string>();
  scan(text('xl/_rels/workbook.xml.rels') ?? '', {
    open(name, a) {
      if (name === 'Relationship' && a.Id !== undefined && a.Target !== undefined)
        targets.set(a.Id, partPath(a.Target));
    },
  });
  const sheetsMeta: { name: string; path: string; hidden: boolean }[] = [];
  const skipped = new Map<string, number>();
  scan(workbookXml, {
    open(name, a) {
      if (name === 'sheet') {
        const path = targets.get(a.id);
        if (path === undefined) throw new Error(`The sheet '${a.name}' has no part.`);
        sheetsMeta.push({
          name: a.name,
          path,
          hidden: a.state === 'hidden' || a.state === 'veryHidden',
        });
      } else if (name === 'definedName')
        skipped.set('defined name', (skipped.get('defined name') ?? 0) + 1);
    },
  });
  const strings = readSharedStrings(text('xl/sharedStrings.xml'));
  const styles = readStyles(text('xl/styles.xml'));
  let cells = 0;
  let formulas = 0;
  const used = new Set<string>();
  const sheets: CellsSheet[] = sheetsMeta.map((meta, i) => {
    const xml = text(meta.path);
    if (xml === undefined) throw new Error(`The sheet '${meta.name}' has no ${meta.path}.`);
    if (meta.hidden)
      skipped.set('hidden sheet (shown)', (skipped.get('hidden sheet (shown)') ?? 0) + 1);
    const read = readSheet(xml, strings, skipped);
    cells += read.cells;
    formulas += read.formulas;
    let id = `s${i + 1}`;
    while (used.has(id)) id += '_';
    used.add(id);
    return { id, name: meta.name, ...read.sheet };
  });
  for (const path of Object.keys(files)) {
    if (path.startsWith('xl/charts/')) skipped.set('chart', (skipped.get('chart') ?? 0) + 1);
    else if (path.startsWith('xl/media/')) skipped.set('image', (skipped.get('image') ?? 0) + 1);
    else if (/^xl\/comments\d*\.xml$/.test(path) || path.startsWith('xl/threadedComments/'))
      skipped.set('comments', (skipped.get('comments') ?? 0) + 1);
    else if (path.startsWith('xl/pivotTables/'))
      skipped.set('pivot table', (skipped.get('pivot table') ?? 0) + 1);
  }
  // Style indexes past the table (a damaged file) fall back to the default.
  for (const s of sheets)
    for (const r of Object.values(s.rows))
      for (const c of Object.values(r.cells) as { s?: number }[])
        if (c.s !== undefined && c.s >= styles.length) delete c.s;
  return {
    workbook: { version: 1, sheets, styles: styles.length > 0 ? styles : [{}] },
    report: {
      sheets: sheets.length,
      cells,
      formulas,
      skipped: [...skipped].map(([feature, count]) => ({ feature, count })),
    },
  };
}
