/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The built-in cell types, contributed through `datalayer.cells.cellType` as
 * any plugin would (§3.11): a checkbox (Space or a click toggles it), a link
 * (Enter or a click opens it) and a progress bar (its fraction typed). A cell
 * takes one through its style: `{ type: 'checkbox' }`.
 *
 * @module builtins/cellTypes
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import {
  type CellActivation,
  type CellRect,
  CellsCellTypes,
  type CellType,
  type CellTypeCell,
} from '../points/index.js';
import type { CellsModel } from '../core/model.js';
import { display } from '../render/numberFormat.js';
import type { Style } from '../core/styles.js';
import { type CellValue, isCellError } from '../core/values.js';
import type { CellsTheme } from '../render/theme.js';

/** The name of `CellsCellTypesPlugin`, for `usePlugin` and `reactor.disable`. */
export const CELLS_CELL_TYPES_PLUGIN = '@datalayer/cells-cell-types';

const PADDING = 3;

function font(style: Style, theme: CellsTheme, zoom: number): string {
  const size = (style.size ?? theme.fontSize) * zoom;
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}px ${style.font ?? theme.fontFamily}`;
}

/** The text a value shows, as the grid would show it unformatted. */
function textOf(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (isCellError(value)) return value.error;
  return String(value);
}

function drawPlainText(
  ctx: CanvasRenderingContext2D,
  rect: CellRect,
  text: string,
  style: Style,
  theme: CellsTheme,
  color: string,
  align: 'left' | 'center' | 'right',
): { x: number; width: number; baseline: number } {
  ctx.font = font(style, theme, rect.zoom);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  const pad = PADDING * rect.zoom;
  const x =
    align === 'right'
      ? rect.x + rect.width - pad - w
      : align === 'center'
        ? rect.x + (rect.width - w) / 2
        : rect.x + pad;
  const baseline = rect.y + rect.height / 2;
  ctx.fillText(text, x, baseline);
  return { x, width: w, baseline };
}

// ------------------------------------------------------------------ checkbox

/** A checkbox is checked for `true` and for a number other than 0; anything else is unchecked. */
export function isChecked(value: CellValue): boolean {
  return value === true || (typeof value === 'number' && value !== 0);
}

/** The checkbox's square inside a cell: centred unless the style aligns it, at most 14 px at zoom 1. */
export function checkboxBox(
  rect: { width: number; height: number; zoom: number },
  align?: Style['align'],
): { x: number; y: number; size: number } {
  const size = Math.max(6, Math.min(14 * rect.zoom, rect.height - 6 * rect.zoom));
  const pad = PADDING * rect.zoom;
  const x =
    align === 'left' ? pad : align === 'right' ? rect.width - pad - size : (rect.width - size) / 2;
  return { x, y: (rect.height - size) / 2, size };
}

export const checkbox: CellType = {
  id: 'checkbox',
  activateOn: [' '],
  render(ctx, rect, value, style, theme) {
    const box = checkboxBox(rect, style.align);
    const x = rect.x + box.x;
    const y = rect.y + box.y;
    const checked = isChecked(value);
    const accent = theme.forcedColors ? theme.text : theme.activeCellBorder;
    ctx.lineWidth = Math.max(1, rect.zoom);
    if (checked) {
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, box.size, box.size);
      ctx.strokeStyle = theme.forcedColors ? theme.background : '#ffffff';
      ctx.lineWidth = Math.max(1.5, 2 * rect.zoom);
      ctx.beginPath();
      ctx.moveTo(x + box.size * 0.22, y + box.size * 0.52);
      ctx.lineTo(x + box.size * 0.42, y + box.size * 0.74);
      ctx.lineTo(x + box.size * 0.78, y + box.size * 0.3);
      ctx.stroke();
    } else {
      ctx.strokeStyle = theme.forcedColors ? theme.text : (style.color ?? theme.textMuted);
      ctx.strokeRect(x + 0.5, y + 0.5, box.size - 1, box.size - 1);
    }
    if (isCellError(value)) {
      ctx.fillStyle = theme.errorText;
      ctx.font = `${Math.max(8, theme.headerFontSize - 2) * rect.zoom}px ${theme.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(value.error, x + box.size + 4 * rect.zoom, rect.y + rect.height / 2);
    }
  },
  measure: (_value, _style, _text) => 24,
  hitTest(point, rect) {
    const box = checkboxBox({ ...rect, zoom: 1 });
    const slack = 4;
    return (
      point.x >= box.x - slack &&
      point.x <= box.x + box.size + slack &&
      point.y >= box.y - slack &&
      point.y <= box.y + box.size + slack
    );
  },
  activate(cell, value): CellActivation {
    return {
      command: {
        type: 'SET_CELLS',
        sheet: cell.sheet,
        at: { row: cell.row, col: cell.col },
        cells: [[!isChecked(value)]],
      },
    };
  },
  accessibleName: (value) => (isChecked(value) ? 'checked' : 'not checked'),
};

// ---------------------------------------------------------------------- link

/** The URL a link cell opens: `http(s)://` and `mailto:` as they are, `www.` under https; anything else opens nothing. */
export function linkHref(value: CellValue): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^(https?:\/\/|mailto:)/i.test(text)) return text;
  if (/^www\.[^\s/]+\.[^\s]+$/i.test(text)) return `https://${text}`;
  return undefined;
}

export const link: CellType = {
  id: 'link',
  activateOn: ['Enter'],
  render(ctx, rect, value, style, theme) {
    const text = textOf(value);
    if (text === '') return;
    const color = isCellError(value) ? theme.errorText : (style.color ?? theme.linkText);
    const drawn = drawPlainText(ctx, rect, text, style, theme, color, style.align ?? 'left');
    if (linkHref(value) !== undefined && !style.strike) {
      const size = (style.size ?? theme.fontSize) * rect.zoom;
      ctx.fillRect(drawn.x, drawn.baseline + size * 0.45, drawn.width, Math.max(1, rect.zoom));
    }
  },
  measure: (value, _style, text) => text(textOf(value)) + 2 * PADDING,
  activate(_cell, value): CellActivation {
    const href = linkHref(value);
    return href === undefined ? undefined : { open: href };
  },
  accessibleName: (value) => {
    const text = textOf(value);
    if (text === '') return '';
    return linkHref(value) === undefined ? text : `${text}, link`;
  },
};

// ------------------------------------------------------------------ progress

/** A progress value as a fraction of 1 (a number clamped to 0..1), or `undefined` for anything but a number. */
export function progressOf(value: CellValue): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

export const progress: CellType = {
  id: 'progress',
  render(ctx, rect, value, style, theme) {
    const fraction = progressOf(value);
    if (fraction === undefined) {
      const text = textOf(value);
      if (text !== '')
        drawPlainText(
          ctx,
          rect,
          text,
          style,
          theme,
          isCellError(value) ? theme.errorText : (style.color ?? theme.text),
          style.align ?? 'left',
        );
      return;
    }
    const z = rect.zoom;
    const pad = PADDING * z;
    const label = `${Math.round(fraction * 100)}%`;
    ctx.font = `${Math.max(8, theme.headerFontSize - 1) * z}px ${theme.fontFamily}`;
    const labelWidth = ctx.measureText(label).width;
    const barX = rect.x + pad;
    const barWidth = Math.max(0, rect.width - 3 * pad - labelWidth);
    const barHeight = Math.max(4, Math.min(8 * z, rect.height - 2 * pad));
    const barY = rect.y + (rect.height - barHeight) / 2;
    ctx.fillStyle = theme.forcedColors ? theme.background : theme.gridline;
    ctx.fillRect(barX, barY, barWidth, barHeight);
    if (theme.forcedColors) {
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(barX + 0.5, barY + 0.5, barWidth - 1, barHeight - 1);
    }
    ctx.fillStyle = style.color ?? (theme.forcedColors ? theme.text : theme.activeCellBorder);
    ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
    ctx.fillStyle = theme.textMuted;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, rect.x + rect.width - pad - labelWidth, rect.y + rect.height / 2);
  },
  measure: () => 80,
  accessibleName: (value) => {
    const fraction = progressOf(value);
    return fraction === undefined ? textOf(value) : `${Math.round(fraction * 100)} percent`;
  },
};

// ------------------------------------------------------------------ code

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** The first line of a source, trimmed. */
export function firstLine(source: string): string {
  return source.trim().split('\n')[0]?.trim() ?? '';
}

/** What a code cell reads as (§3.13): "Code, last run 10:42, result 42" (or not run, running, stale, an error). */
export function codeName(value: CellValue, cell: CellTypeCell | undefined): string {
  const m = cell?.model as CellsModel | undefined;
  const code = m?.code(cell!.sheet, cell!.row, cell!.col);
  const state = m?.codeState(cell!.sheet, cell!.row, cell!.col);
  const parts = ['Code'];
  if (state === 'running') parts.push('running');
  else if (code?.lastRun !== undefined) {
    const t = new Date(code.lastRun);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    parts.push(`last run ${hh}:${mm}`);
  } else parts.push('not run');
  if (state === 'stale') parts.push('stale');
  if (state !== 'running') {
    if (value !== null)
      parts.push(`result ${isCellError(value) ? value.error : display(value).text}`);
    else if (code !== undefined && code.lastRun === undefined) parts.push(firstLine(code.source));
  }
  return parts.join(', ');
}

/**
 * A code cell (§3.13, C11-02): a badge, then the result as a value would show
 * (or, before its first run, the source's first line in monospace), `#BUSY!`
 * while it runs, and a corner mark when what it reads changed since its run.
 */
export const code: CellType = {
  id: 'code',
  paintsEmpty: true,
  editable: false,
  render(ctx, rect, value, style, theme, cell) {
    const m = cell?.model as CellsModel | undefined;
    const source = cell !== undefined ? m?.code(cell.sheet, cell.row, cell.col) : undefined;
    const state = cell !== undefined ? m?.codeState(cell.sheet, cell.row, cell.col) : undefined;
    const z = rect.zoom;
    // The badge: a small rounded square with a chevron, in the accent colour.
    const size = Math.max(6, Math.min(12 * z, rect.height - 6 * z));
    const bx = rect.x + PADDING * z;
    const by = rect.y + (rect.height - size) / 2;
    ctx.strokeStyle = theme.activeCellBorder;
    ctx.lineWidth = Math.max(1, z);
    ctx.strokeRect(bx + 0.5, by + 0.5, size - 1, size - 1);
    ctx.beginPath();
    ctx.moveTo(bx + size * 0.3, by + size * 0.3);
    ctx.lineTo(bx + size * 0.55, by + size * 0.5);
    ctx.lineTo(bx + size * 0.3, by + size * 0.7);
    ctx.moveTo(bx + size * 0.6, by + size * 0.72);
    ctx.lineTo(bx + size * 0.78, by + size * 0.72);
    ctx.stroke();
    const after = { ...rect, x: bx + size, width: rect.width - (bx + size - rect.x) };
    if (state === 'running') {
      drawPlainText(ctx, after, '#BUSY!', style, theme, theme.errorText, 'right');
    } else if (value !== null) {
      const shown = display(value, style.format);
      const color = isCellError(value) ? theme.errorText : (style.color ?? theme.text);
      const align =
        style.align ?? (typeof value === 'number' || isCellError(value) ? 'right' : 'left');
      drawPlainText(
        ctx,
        after,
        shown.text,
        style,
        theme,
        color,
        align === 'center' ? 'center' : align,
      );
    } else if (source !== undefined) {
      const mono = { ...style, font: theme.monoFontFamily ?? MONO };
      drawPlainText(ctx, after, firstLine(source.source), mono, theme, theme.textMuted, 'left');
    }
    if (state === 'stale') {
      // The stale mark: a triangle in the top-right corner.
      const t = Math.max(4, 6 * z);
      ctx.fillStyle = theme.textMuted;
      ctx.beginPath();
      ctx.moveTo(rect.x + rect.width - t, rect.y);
      ctx.lineTo(rect.x + rect.width, rect.y);
      ctx.lineTo(rect.x + rect.width, rect.y + t);
      ctx.closePath();
      ctx.fill();
    }
  },
  measure: (value, _style, text) => text(textOf(value)) + 18 + 2 * PADDING,
  accessibleName: (value, _style, cell) => codeName(value, cell),
};

/** The built-in cell types, in the order they are contributed. */
export const CELL_TYPES: readonly CellType[] = [checkbox, link, progress, code];

/** Checkbox, link and progress bar, through the `datalayer.cells.cellType` point. */
export const CellsCellTypesPlugin = definePlugin({
  name: CELLS_CELL_TYPES_PLUGIN,
  displayName: 'Cell types',
  description: 'The built-in cell types: checkbox, link, progress bar and code.',
  octicon: 'checkbox',
  contributes: CELL_TYPES.map((type) =>
    contribution(CellsCellTypes, type, { id: type.id, order: 100 }),
  ),
});
