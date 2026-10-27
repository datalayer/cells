/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The system clipboard's formats. Out: tab-separated text of what the cells
 * show, and an HTML table with inline styles (Excel, Sheets and LibreOffice
 * read it) that also carries the slice itself, so two Cells grids exchange
 * cells losslessly. In: a Cells slice, else an HTML table (Excel's
 * `x:num` and class styles, Sheets' `data-sheets-value`), else text.
 *
 * @module react/clipboard
 */

import { checkSlice, parseTSV, type Slice, sliceFromText, toTSV } from '../core/clipboard.js';
import type { CellsModel } from '../core/model.js';
import { checkFormatCode } from '../core/numfmt.js';
import type { Style } from '../core/styles.js';
import type { CellValue } from '../core/values.js';
import { display } from '../render/numberFormat.js';

/** The attribute the slice travels in, on the HTML table. */
export const SLICE_ATTRIBUTE = 'data-cells-slice';

const escapeHTML = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function css(style: Style | undefined): string {
  if (style === undefined) return '';
  const out: string[] = [];
  if (style.bold) out.push('font-weight:bold');
  if (style.italic) out.push('font-style:italic');
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  if (deco) out.push(`text-decoration:${deco}`);
  if (style.color) out.push(`color:${style.color}`);
  if (style.fill) out.push(`background-color:${style.fill}`);
  if (style.align) out.push(`text-align:${style.align}`);
  if (style.valign) out.push(`vertical-align:${style.valign}`);
  if (style.size) out.push(`font-size:${style.size}px`);
  if (style.font) out.push(`font-family:${style.font}`);
  if (style.wrap) out.push('white-space:normal');
  return out.join(';');
}

/** What a slice shows, as rows of text: the values under their formats. */
function shownRows(
  slice: Slice,
  model: CellsModel,
): { text: string[][]; styles: (Style | undefined)[][] } {
  const text = Array.from({ length: slice.rows }, () =>
    Array.from({ length: slice.cols }, () => ''),
  );
  const styles: (Style | undefined)[][] = Array.from({ length: slice.rows }, () =>
    Array.from({ length: slice.cols }, () => undefined),
  );
  const cells =
    (slice.parts.cells as
      { r: number; c: number; v?: CellValue; f?: string; style?: Style }[] | undefined) ?? [];
  const source = slice.source;
  for (const cell of cells) {
    const value: CellValue =
      cell.f !== undefined && source !== undefined && model.workbook.hasSheet(source.sheet)
        ? model.value(source.sheet, source.zone.top + cell.r, source.zone.left + cell.c)
        : (cell.v ?? null);
    text[cell.r][cell.c] = display(value, cell.style?.format).text;
    styles[cell.r][cell.c] = cell.style;
  }
  return { text, styles };
}

/** The clipboard's text and HTML for a slice. */
export function sliceToClipboard(slice: Slice, model: CellsModel): { text: string; html: string } {
  const { text, styles } = shownRows(slice, model);
  const rows = text
    .map(
      (row, r) =>
        `<tr>${row
          .map((t, c) => {
            const style = css(styles[r][c]);
            return `<td${style ? ` style="${escapeHTML(style)}"` : ''}>${escapeHTML(t).replace(/\n/g, '<br>')}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const html = `<meta charset="utf-8"><table ${SLICE_ATTRIBUTE}="${escapeHTML(JSON.stringify(slice))}" style="border-collapse:collapse">${rows}</table>`;
  return { text: toTSV(text), html };
}

/** CSS declarations as a style, for what a cell's HTML says about its look. */
function styleFromCSS(declarations: Record<string, string>): Style | undefined {
  const s: { -readonly [K in keyof Style]?: Style[K] } = {};
  const weight = declarations['font-weight'];
  if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) s.bold = true;
  if (declarations['font-style'] === 'italic') s.italic = true;
  const deco = declarations['text-decoration'] ?? declarations['text-decoration-line'] ?? '';
  if (deco.includes('underline')) s.underline = true;
  if (deco.includes('line-through')) s.strike = true;
  const color = declarations.color;
  if (color && !/^(windowtext|black|#000000|#000|rgb\(0, 0, 0\))$/i.test(color)) s.color = color;
  const fill = declarations['background-color'] ?? declarations.background;
  if (fill && !/^(transparent|white|#ffffff|#fff|rgb\(255, 255, 255\)|none|initial)$/i.test(fill))
    s.fill = fill;
  const align = declarations['text-align'];
  if (align === 'left' || align === 'center' || align === 'right') s.align = align;
  // Bottom is the default in Excel, Sheets and Cells alike: only the others are a style.
  const valign = declarations['vertical-align'];
  if (valign === 'top' || valign === 'middle') s.valign = valign;
  const format = (declarations['mso-number-format'] ?? declarations['data-sheets-numberformat'])
    ?.replace(/^"|"$/g, '')
    .replace(/\\(.)/g, '$1');
  if (format) {
    try {
      checkFormatCode(format);
      s.format = format;
    } catch {
      // Excel's format, which Cells cannot show yet: the cell keeps its value, not this format.
    }
  }
  return Object.keys(s).length > 0 ? s : undefined;
}

/** CSS declarations, split on the semicolons outside quotes and escapes (Excel's mso-number-format holds `\;`). */
function parseDeclarations(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      cur += ch + text[i + 1];
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
      cur += ch;
    } else if (ch === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return out;
}

/** The value a foreign cell holds: Excel's x:num, Sheets' data-sheets-value, else its text read as typed. */
function foreignValue(td: Element, text: string): { v?: CellValue; f?: string } {
  const num = td.getAttribute('x:num') ?? td.getAttribute('num');
  if (num !== null) {
    const n = Number(num === '' ? text.replace(/[^0-9.eE+-]/g, '') : num);
    if (Number.isFinite(n)) return { v: n };
  }
  const bool = td.getAttribute('x:bool');
  if (bool !== null) return { v: bool.toUpperCase() === 'TRUE' };
  const formula = td.getAttribute('x:fmla') ?? td.getAttribute('data-sheets-formula');
  const sheets = td.getAttribute('data-sheets-value');
  if (sheets !== null) {
    try {
      const v = JSON.parse(sheets) as Record<string, unknown>;
      if (typeof v['3'] === 'number') return { v: v['3'] as number };
      if (typeof v['2'] === 'string') return { v: v['2'] as string };
      if (typeof v['4'] === 'number') return { v: v['4'] === 1 };
    } catch {
      // Not Sheets' JSON: read the text.
    }
  }
  if (formula !== null && formula.startsWith('=')) {
    // A formula from another application keeps its text; its references are its own (adjusted by C4's engine).
    return { f: formula.slice(1) };
  }
  const slice = sliceFromText([[text]]);
  const cell = (slice.parts.cells as { v?: CellValue; f?: string }[])[0];
  return cell === undefined
    ? {}
    : {
        ...(cell.v !== undefined ? { v: cell.v } : {}),
        ...(cell.f !== undefined ? { f: cell.f } : {}),
      };
}

/** A slice from the clipboard: Cells' own, an HTML table, or text. `undefined` when it holds nothing usable. */
export function sliceFromClipboard(
  html: string | undefined,
  text: string | undefined,
): Slice | undefined {
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const own = doc.querySelector(`[${SLICE_ATTRIBUTE}]`);
    if (own !== null) {
      const slice = JSON.parse(own.getAttribute(SLICE_ATTRIBUTE)!) as unknown;
      checkSlice(slice);
      return slice;
    }
    const table = doc.querySelector('table');
    if (table !== null) {
      // Excel writes its styles as classes in a <style> block.
      const classes = new Map<string, Record<string, string>>();
      for (const styleEl of doc.querySelectorAll('style')) {
        const body = (styleEl.textContent ?? '').replace(/<!--|-->/g, '');
        for (const m of body.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g))
          classes.set(m[1], parseDeclarations(m[2]));
      }
      const cells: { r: number; c: number; v?: CellValue; f?: string; style?: Style }[] = [];
      const taken = new Set<string>();
      let rows = 0;
      let cols = 0;
      table.querySelectorAll('tr').forEach((tr, r) => {
        let c = 0;
        tr.querySelectorAll('td, th').forEach((td) => {
          while (taken.has(`${r},${c}`)) c += 1;
          const span = Math.max(1, Number(td.getAttribute('colspan') ?? 1));
          const rowSpan = Math.max(1, Number(td.getAttribute('rowspan') ?? 1));
          for (let dr = 0; dr < rowSpan; dr += 1)
            for (let dc = 0; dc < span; dc += 1) taken.add(`${r + dr},${c + dc}`);
          const brs = td.querySelectorAll('br');
          brs.forEach((br) => br.replaceWith('\n'));
          const text = (td.textContent ?? '').replace(/ /g, ' ');
          const sheetsFormat = td.getAttribute('data-sheets-numberformat');
          let sheetsPattern: string | undefined;
          if (sheetsFormat !== null) {
            try {
              const f = JSON.parse(sheetsFormat) as Record<string, unknown>;
              if (typeof f['2'] === 'string') sheetsPattern = f['2'];
            } catch {
              // Not Sheets' JSON: no format.
            }
          }
          const declarations = {
            ...(sheetsPattern !== undefined ? { 'data-sheets-numberformat': sheetsPattern } : {}),
            ...Object.assign(
              {},
              ...(td.getAttribute('class') ?? '')
                .split(/\s+/)
                .filter(Boolean)
                .map((k) => classes.get(k) ?? {}),
            ),
            ...parseDeclarations(td.getAttribute('style') ?? ''),
          };
          const style = styleFromCSS(declarations);
          const value = foreignValue(td, text.trim() === '' ? '' : text);
          if (value.v !== undefined || value.f !== undefined || style !== undefined)
            cells.push({ r, c, ...value, ...(style ? { style } : {}) });
          c += span;
          cols = Math.max(cols, c);
        });
        rows = r + 1;
      });
      if (rows > 0 && cols > 0) return { version: 1, rows, cols, parts: { cells } };
    }
  }
  if (text !== undefined && text !== '') return sliceFromText(parseTSV(text));
  return undefined;
}
