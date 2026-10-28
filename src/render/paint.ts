/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Painting a frame: the grid canvas (backgrounds, grid lines, merges, text
 * with Excel's overflow, borders, headers, the frozen edges) and the overlay
 * canvas (the selection). Works on any 2D context: the browser's, or
 * `@napi-rs/canvas`'s in the snapshot tests.
 *
 * Paint order per pane: fills and grid lines, then merges over them, then
 * text, then borders. Hairlines sit on device pixels (half-pixel
 * arithmetic), so they stay one device pixel wide at any DPR and zoom.
 *
 * @module render/paint
 */

import type { Axis } from '../core/axis.js';
import type { CellContent } from '../core/cells.js';
import type { SelectionState } from '../core/selection.js';
import type { Style } from '../core/styles.js';
import type { CellValue } from '../core/values.js';
import type { Sheet } from '../core/workbook.js';
import { columnLetters, type Zone, zonesOverlap } from '../core/zone.js';
import type { TextMeasure } from './lru.js';
import type { NumberLocale } from '../core/numfmt.js';
import { type Align, type Displayed, display } from './numberFormat.js';
import type { CellType, RenderLayer, RenderLayerView } from '../points/index.js';
import type { CellsTheme } from './theme.js';
import { cellRect, type Pane, type Viewport } from './viewport.js';

/** The context methods painting uses: the browser's 2D context and `@napi-rs/canvas`'s both have them. */
export type Ctx = CanvasRenderingContext2D;

export interface PaintInput {
  readonly ctx: Ctx;
  readonly dpr: number;
  readonly viewport: Viewport;
  readonly sheet: Sheet;
  readonly styles: { get(index: number): Style };
  readonly theme: CellsTheme;
  readonly measure: TextMeasure;
  readonly showGridlines: boolean;
  /** What a cell of the sheet shows: its value, or its formula evaluated. */
  readonly value: (row: number, col: number) => CellValue;
  /** The cell type of that id (§3.11), when a plugin contributes it; a cell whose style names one is drawn by it. */
  readonly cellType?: (id: string) => CellType | undefined;
  /**
   * The zone a data source is bound to (C7-03): its empty cells are read through `value`, which
   * requests their page and shows `#BUSY!` meanwhile (or `#N/A` once it failed).
   */
  readonly bound?: Zone;
  /** The render layers plugins contribute (§3.11), in order; `background` and `cells` ones draw here. */
  readonly layers?: readonly RenderLayer[];
  /** What the layers are handed: the model the grid draws. */
  readonly model?: unknown;
  /** Decimal and group separators, month and day names; en-US by default. */
  readonly locale?: NumberLocale;
  /** Only this rectangle (view px) is repainted; the whole canvas by default. */
  readonly clip?: { x: number; y: number; width: number; height: number };
}

export interface PaintStats {
  cells: number;
  texts: number;
}

const PADDING = 3;
/** How far left of a pane to look for text overflowing into it. */
const OVERFLOW_LOOKBACK = 20;

export function fontOf(style: Style, theme: CellsTheme, zoom: number): string {
  const size = (style.size ?? theme.fontSize) * zoom;
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}px ${style.font ?? theme.fontFamily}`;
}

/** A horizontal hairline on device pixels. */
function hline(ctx: Ctx, dpr: number, x0: number, x1: number, y: number): void {
  const yy = Math.round(y * dpr) + 0.5;
  ctx.moveTo(Math.round(x0 * dpr), yy);
  ctx.lineTo(Math.round(x1 * dpr), yy);
}

function vline(ctx: Ctx, dpr: number, x: number, y0: number, y1: number): void {
  const xx = Math.round(x * dpr) + 0.5;
  ctx.moveTo(xx, Math.round(y0 * dpr));
  ctx.lineTo(xx, Math.round(y1 * dpr));
}

/** Run `draw` in device pixels (identity transform), restoring the CSS-pixel transform after. */
function device(ctx: Ctx, draw: () => void): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  draw();
  ctx.restore();
}

function clipTo(ctx: Ctx, r: { x: number; y: number; width: number; height: number }): void {
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
}

function visibleIndexes(axis: Axis, first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i += 1) if (axis.effectiveSizeOf(i) > 0) out.push(i);
  return out;
}

function isEmpty(c: CellContent | null): boolean {
  return c === null || (c.value === null && c.formula === undefined);
}

function intersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x;
  const h = Math.min(a.y + a.height, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : undefined;
}

/** Paint the grid canvas, or the `clip` part of it. */
export function paintGrid(input: PaintInput): PaintStats {
  const { ctx, dpr, viewport: vp } = input;
  const stats: PaintStats = { cells: 0, texts: 0 };
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (input.clip) clipTo(ctx, input.clip);
  const full = { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };
  for (const pane of vp.panes) {
    const area = intersect(
      { x: pane.x, y: pane.y, width: pane.width, height: pane.height },
      input.clip ?? full,
    );
    if (area === undefined) continue;
    ctx.save();
    clipTo(ctx, area);
    paintPane(input, input.clip ? narrow(pane, area, vp.zoom, input.sheet) : pane, stats);
    ctx.restore();
  }
  paintHeaders(input);
  paintFrozenEdges(input);
  ctx.restore();
  return stats;
}

/**
 * A pane cut down to the rows a repainted area crosses, and the columns it
 * crosses give or take the overflow look-back: text from a column outside the
 * area may run into it.
 */
function narrow(
  pane: Pane,
  area: { x: number; y: number; width: number; height: number },
  zoom: number,
  sheet: Sheet,
): Pane {
  if (pane.lastRow < pane.firstRow || pane.lastCol < pane.firstCol) return pane;
  const sy0 = pane.originY + (area.y - pane.y) / zoom;
  const sy1 = pane.originY + (area.y + area.height - pane.y) / zoom;
  const sx0 = pane.originX + (area.x - pane.x) / zoom;
  const sx1 = pane.originX + (area.x + area.width - pane.x) / zoom;
  const firstRow = Math.max(pane.firstRow, sheet.rows.indexAt(sy0));
  const lastRow = Math.min(pane.lastRow, sheet.rows.indexAt(sy1));
  const firstCol = Math.max(pane.firstCol, sheet.cols.indexAt(sx0) - OVERFLOW_LOOKBACK);
  const lastCol = Math.min(pane.lastCol, sheet.cols.indexAt(sx1) + OVERFLOW_LOOKBACK);
  return { ...pane, firstRow, lastRow, firstCol, lastCol };
}

function paintPane(input: PaintInput, pane: Pane, stats: PaintStats): void {
  const { ctx, dpr, viewport: vp, sheet, styles, theme, measure } = input;
  const z = vp.zoom;
  ctx.fillStyle = theme.background;
  ctx.fillRect(pane.x, pane.y, pane.width, pane.height);
  if (pane.lastRow < pane.firstRow || pane.lastCol < pane.firstCol) return;
  const rows = visibleIndexes(sheet.rows, pane.firstRow, pane.lastRow);
  const cols = visibleIndexes(sheet.cols, pane.firstCol, pane.lastCol);
  const rect = (r: number, c: number) => cellRect(pane, z, sheet.rows, sheet.cols, r, c);

  // 1. Fills.
  for (const r of rows) {
    for (const c of cols) {
      const content = sheet.cells.get(r, c);
      if (content === null) continue;
      stats.cells += 1;
      const fill = styles.get(content.style).fill;
      if (fill) {
        const b = rect(r, c);
        ctx.fillStyle = fill;
        ctx.fillRect(b.x, b.y, b.width, b.height);
      }
    }
  }

  // 2. Grid lines, on device pixels.
  if (input.showGridlines) {
    device(ctx, () => {
      ctx.beginPath();
      ctx.strokeStyle = theme.gridline;
      ctx.lineWidth = 1;
      const right = pane.x + pane.width;
      const bottom = pane.y + pane.height;
      for (const r of rows) {
        const b = rect(r, cols[0] ?? pane.firstCol);
        hline(ctx, dpr, pane.x, right, b.y + b.height - 1 / dpr);
      }
      for (const c of cols) {
        const b = rect(rows[0] ?? pane.firstRow, c);
        vline(ctx, dpr, b.x + b.width - 1 / dpr, pane.y, bottom);
      }
      ctx.stroke();
    });
  }

  drawLayers(input, 'background', pane, sheet, ctx);

  // 3. Merges, over the grid lines they hide: background, the top-left cell's fill and text.
  const paneZone: Zone = {
    top: pane.firstRow,
    left: pane.firstCol,
    bottom: pane.lastRow,
    right: pane.lastCol,
  };
  const merges = sheet.merges.filter((m) => zonesOverlap(m, paneZone));
  for (const m of merges) {
    const tl = rect(m.top, m.left);
    const br = rect(m.bottom, m.right);
    const box = {
      x: tl.x,
      y: tl.y,
      width: br.x + br.width - tl.x - 1 / dpr,
      height: br.y + br.height - tl.y - 1 / dpr,
    };
    const content = sheet.cells.get(m.top, m.left);
    const style = styles.get(content?.style ?? 0);
    ctx.fillStyle = style.fill ?? theme.background;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    const mergeType = content === null ? undefined : typeOf(input, style);
    if (content !== null && (!isEmpty(content) || mergeType?.paintsEmpty === true)) {
      const type = mergeType;
      if (type !== undefined)
        drawTyped(input, type, box, input.value(m.top, m.left), style, stats, m.top, m.left);
      else
        drawText(
          input,
          display(input.value(m.top, m.left), style.format, input.locale),
          style,
          box,
          box,
          stats,
        );
    }
  }
  const inMerge = (r: number, c: number) =>
    merges.some((m) => r >= m.top && r <= m.bottom && c >= m.left && c <= m.right);

  // 4. Text, with Excel's overflow into empty neighbours.
  for (const r of rows) {
    const first = cols[0];
    if (first === undefined) break;
    // Text from cells left of the pane may overflow into it.
    const lookback: number[] = [];
    const minCol = pane.name === 'main' || pane.name === 'top' ? sheet.frozen.cols : 0;
    for (let c = first - 1; c >= Math.max(minCol, first - OVERFLOW_LOOKBACK); c -= 1) {
      if (sheet.cols.effectiveSizeOf(c) > 0) lookback.unshift(c);
    }
    const scan = [...lookback, ...cols];
    const bound = input.bound;
    const inBound = bound !== undefined && r >= bound.top && r <= bound.bottom;
    for (let k = 0; k < scan.length; k += 1) {
      const c = scan[k];
      let content = sheet.cells.get(r, c);
      if (content === null && inBound && c >= bound.left && c <= bound.right) {
        // A bound cell whose page is away: read it (which asks for the page) and show what it says.
        const away = input.value(r, c);
        if (away === null) continue;
        content = { value: away, style: 0 };
        stats.cells += 1;
      }
      if (content === null || inMerge(r, c)) continue;
      const style = styles.get(content.style);
      const type = typeOf(input, style);
      if (isEmpty(content) && type?.paintsEmpty !== true) continue;
      const cell = rect(r, c);
      if (type !== undefined) {
        // A typed cell is drawn by its type, in its own rectangle: it never overflows.
        if (k >= lookback.length)
          drawTyped(input, type, cell, input.value(r, c), style, stats, r, c);
        continue;
      }
      const shown = display(input.value(r, c), style.format, input.locale);
      let span = cell;
      if (shown.kind === 'text' && !style.wrap) {
        const font = fontOf(style, theme, z);
        const need = measure.width(ctx, font, shown.text) + 2 * PADDING * z;
        const align: Align = style.align ?? shown.align;
        if (need > cell.width) {
          let x0 = cell.x;
          let x1 = cell.x + cell.width;
          const free = (cc: number) =>
            cc >= 0 && cc < sheet.cols.count && isEmpty(sheet.cells.get(r, cc)) && !inMerge(r, cc);
          if (align !== 'right') {
            for (let cc = c + 1; free(cc) && x1 - x0 < need; cc += 1)
              x1 = rect(r, cc).x + rect(r, cc).width;
          }
          if (align !== 'left') {
            for (let cc = c - 1; free(cc) && x1 - x0 < need; cc -= 1) x0 = rect(r, cc).x;
          }
          span = { x: x0, y: cell.y, width: x1 - x0, height: cell.height };
        }
      }
      if (k < lookback.length && span.x + span.width <= rect(r, first).x) continue;
      drawText(input, shown, style, cell, span, stats);
    }
  }

  // 5. Borders.
  for (const r of rows) {
    for (const c of cols) {
      const content = sheet.cells.get(r, c);
      if (content === null) continue;
      const borders = styles.get(content.style).borders;
      if (!borders) continue;
      const b = rect(r, c);
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const border = borders[side];
        if (!border) continue;
        const w = border.style === 'thick' ? 3 : border.style === 'medium' ? 2 : 1;
        ctx.save();
        ctx.strokeStyle = border.color;
        ctx.lineWidth = w;
        if (border.style === 'dashed') ctx.setLineDash([4 * z, 2 * z]);
        if (border.style === 'dotted') ctx.setLineDash([1 * z, 1 * z]);
        ctx.beginPath();
        const x0 = b.x;
        const x1 = b.x + b.width;
        const y0 = b.y;
        const y1 = b.y + b.height;
        // A double border is two hairlines, 2 px apart.
        const offsets = border.style === 'double' ? [-1, 1] : [0];
        for (const o of offsets) {
          if (side === 'top') (ctx.moveTo(x0, y0 + o), ctx.lineTo(x1, y0 + o));
          if (side === 'bottom') (ctx.moveTo(x0, y1 + o), ctx.lineTo(x1, y1 + o));
          if (side === 'left') (ctx.moveTo(x0 + o, y0), ctx.lineTo(x0 + o, y1));
          if (side === 'right') (ctx.moveTo(x1 + o, y0), ctx.lineTo(x1 + o, y1));
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawLayers(input, 'cells', pane, sheet, ctx);
}

/** A pane as a render layer sees it. */
function layerView(pane: Pane, zoom: number, sheet: Sheet): RenderLayerView {
  return {
    sheet: sheet.id,
    zone: { top: pane.firstRow, left: pane.firstCol, bottom: pane.lastRow, right: pane.lastCol },
    pane: pane.name,
    zoom,
    cellRect: (row, col) => ({ ...cellRect(pane, zoom, sheet.rows, sheet.cols, row, col), zoom }),
  };
}

/** The contributed layers of a kind, each in its own saved state, clipped to the pane. */
function drawLayers(
  input: { layers?: readonly RenderLayer[]; model?: unknown; viewport: Viewport },
  kind: RenderLayer['layer'],
  pane: Pane,
  sheet: Sheet,
  ctx: Ctx,
): void {
  if (input.layers === undefined) return;
  let view: RenderLayerView | undefined;
  for (const layer of input.layers) {
    if (layer.layer !== kind) continue;
    view ??= layerView(pane, input.viewport.zoom, sheet);
    ctx.save();
    clipTo(ctx, pane);
    try {
      layer.draw(ctx, view, input.model);
    } finally {
      ctx.restore();
    }
  }
}

/** The cell type a style names, when the grid resolves it. */
function typeOf(input: PaintInput, style: Style): CellType | undefined {
  return style.type === undefined || input.cellType === undefined
    ? undefined
    : input.cellType(style.type);
}

/** A cell drawn by its type, clipped to its rectangle (the fill was painted with the other fills). */
function drawTyped(
  input: PaintInput,
  type: CellType,
  cell: { x: number; y: number; width: number; height: number },
  value: CellValue,
  style: Style,
  stats: PaintStats,
  row: number,
  col: number,
): void {
  const { ctx } = input;
  ctx.save();
  clipTo(ctx, cell);
  // A hairline's width is kept out: the grid lines sit on the cell's right and bottom edge.
  const inner = {
    x: cell.x,
    y: cell.y,
    width: cell.width - 1,
    height: cell.height - 1,
    zoom: input.viewport.zoom,
  };
  type.render(ctx, inner, value, style, input.theme, {
    sheet: input.sheet.id,
    row,
    col,
    model: input.model,
  });
  ctx.restore();
  stats.texts += 1;
}

/** Draw a cell's shown value in `span` (its own rectangle, or the run it overflows into), clipped. */
function drawText(
  input: PaintInput,
  shown: Displayed,
  style: Style,
  cell: { x: number; y: number; width: number; height: number },
  span: { x: number; y: number; width: number; height: number },
  stats: PaintStats,
): void {
  const { ctx, viewport: vp, theme, measure } = input;
  const z = vp.zoom;
  if (shown.text === '') return;
  const font = fontOf(style, theme, z);
  const pad = PADDING * z;
  let text = shown.text;
  if (shown.kind === 'number' && measure.width(ctx, font, text) + 2 * pad > cell.width) {
    // As Excel: a number never overflows; it shows as #### across its cell.
    const hash = measure.width(ctx, font, '#');
    text = '#'.repeat(Math.max(1, Math.floor((cell.width - 2 * pad) / Math.max(hash, 1))));
  }
  const align: Align = style.align ?? shown.align;
  if (span !== cell && span.width > cell.width) {
    // The text runs over empty neighbours: hide the grid lines between them, as Excel does,
    // keeping the bottom line and the span's outer edges.
    const dpr = input.dpr;
    ctx.fillStyle = style.fill ?? theme.background;
    ctx.fillRect(span.x, span.y, span.width - 1 / dpr, span.height - 1 / dpr);
  }
  ctx.save();
  clipTo(ctx, span);
  ctx.font = font;
  ctx.fillStyle =
    shown.kind === 'error' ? theme.errorText : (shown.color ?? style.color ?? theme.text);
  ctx.textBaseline = 'alphabetic';
  const size = (style.size ?? theme.fontSize) * z;
  const lines = style.wrap ? measure.wrap(ctx, font, text, cell.width - 2 * pad) : [text];
  const lineHeight = size * 1.25;
  const valign = style.valign ?? 'bottom';
  const block = lines.length * lineHeight;
  const top =
    valign === 'top'
      ? cell.y + pad
      : valign === 'middle'
        ? cell.y + (cell.height - block) / 2
        : cell.y + cell.height - pad - block;
  lines.forEach((line, i) => {
    const w = measure.width(ctx, font, line);
    const base = top + (i + 1) * lineHeight - (lineHeight - size) / 2 - size * 0.12;
    const area = style.wrap ? cell : span;
    const x =
      align === 'left'
        ? area.x + pad
        : align === 'right'
          ? area.x + area.width - pad - w
          : area.x + (area.width - w) / 2;
    ctx.fillText(line, x, base);
    if (style.underline || style.strike) {
      ctx.fillRect(x, style.underline ? base + 1.5 * z : base - size * 0.32, w, Math.max(1, z));
    }
  });
  ctx.restore();
  stats.texts += 1;
}

function paintHeaders(input: PaintInput): void {
  const { ctx, dpr, viewport: vp, sheet, theme, measure } = input;
  if (vp.headerHeight === 0) return;
  const z = vp.zoom;
  const font = `${theme.headerFontSize * z}px ${theme.fontFamily}`;
  const hw = vp.headerWidth;
  const hh = vp.headerHeight;
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, 0, ctx.canvas.width / dpr, hh);
  ctx.fillRect(0, 0, hw, ctx.canvas.height / dpr);
  ctx.font = font;
  ctx.fillStyle = theme.headerText;
  ctx.textBaseline = 'middle';
  const lines: (() => void)[] = [];
  for (const pane of vp.panes) {
    if (pane.name === 'main' || pane.name === 'top') {
      ctx.save();
      clipTo(ctx, { x: pane.x, y: 0, width: pane.width, height: hh });
      for (const c of visibleIndexes(sheet.cols, pane.firstCol, pane.lastCol)) {
        const b = cellRect(pane, z, sheet.rows, sheet.cols, pane.firstRow, c);
        const label = columnLetters(c);
        const w = measure.width(ctx, font, label);
        ctx.fillStyle = theme.headerText;
        ctx.fillText(label, b.x + (b.width - w) / 2, hh / 2);
        lines.push(() => vline(ctx, dpr, b.x + b.width - 1 / dpr, 0, hh));
      }
      ctx.restore();
    }
    if (pane.name === 'main' || pane.name === 'left') {
      ctx.save();
      clipTo(ctx, { x: 0, y: pane.y, width: hw, height: pane.height });
      for (const r of visibleIndexes(sheet.rows, pane.firstRow, pane.lastRow)) {
        const b = cellRect(pane, z, sheet.rows, sheet.cols, r, pane.firstCol);
        const label = String(r + 1);
        const w = measure.width(ctx, font, label);
        ctx.fillStyle = theme.headerText;
        ctx.fillText(label, (hw - w) / 2, b.y + b.height / 2);
        lines.push(() => hline(ctx, dpr, 0, hw, b.y + b.height - 1 / dpr));
      }
      ctx.restore();
    }
  }
  device(ctx, () => {
    ctx.beginPath();
    ctx.strokeStyle = theme.headerBorder;
    ctx.lineWidth = 1;
    for (const l of lines) l();
    hline(ctx, dpr, 0, ctx.canvas.width / dpr, hh - 1 / dpr);
    vline(ctx, dpr, hw - 1 / dpr, 0, ctx.canvas.height / dpr);
    ctx.stroke();
  });
}

function paintFrozenEdges(input: PaintInput): void {
  const { ctx, dpr, viewport: vp, theme } = input;
  const corner = vp.panes.find((p) => p.name === 'top' || p.name === 'left' || p.name === 'corner');
  if (corner === undefined) return;
  const main = vp.panes.find((p) => p.name === 'main')!;
  device(ctx, () => {
    ctx.beginPath();
    ctx.strokeStyle = theme.frozenLine;
    ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
    if (vp.panes.some((p) => p.name === 'top'))
      hline(ctx, dpr, 0, main.x + main.width, main.y - 1 / dpr);
    if (vp.panes.some((p) => p.name === 'left'))
      vline(ctx, dpr, main.x - 1 / dpr, 0, main.y + main.height);
    ctx.stroke();
  });
}

export interface OverlayInput {
  readonly ctx: Ctx;
  readonly dpr: number;
  readonly viewport: Viewport;
  readonly sheet: Sheet;
  readonly theme: CellsTheme;
  readonly selection: SelectionState;
  /** The zone last copied or cut, drawn dashed (the marching ants). */
  readonly mark?: { readonly sheet: string; readonly zone: Zone } | null;
  /** The other peers' selections (§3.9), each in its colour with a name tag on its active cell. */
  readonly remote?: readonly {
    readonly user: { readonly name: string; readonly color: string };
    readonly sheet: string;
    readonly zones: readonly Zone[];
    readonly active: { readonly row: number; readonly col: number };
    readonly editing?: { readonly row: number; readonly col: number };
  }[];
  /** The render layers plugins contribute; the `overlay` ones draw here, after the selection. */
  readonly layers?: readonly RenderLayer[];
  readonly model?: unknown;
}

/** The selection fill's opacity: themes give opaque colours (Primer's accent-muted), the overlay thins them. */
export const SELECTION_ALPHA = 0.4;

/** The fill handle's hit square, view px; 24 × 24 CSS px at least for touch and WCAG 2.5.8 is the hit area, 7 px the drawn square. */
export const FILL_HANDLE = 7;

/** Paint the overlay canvas: the selection, the active cell, the fill handle, the selected headers. */
export function paintOverlay(input: OverlayInput): void {
  const { ctx, dpr, viewport: vp, sheet, theme, selection } = input;
  const z = vp.zoom;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
  const zoneRect = (pane: Pane, zone: Zone) => {
    const tl = cellRect(pane, z, sheet.rows, sheet.cols, zone.top, zone.left);
    const brRow = Math.min(zone.bottom, sheet.rows.count - 1);
    const brCol = Math.min(zone.right, sheet.cols.count - 1);
    const x1 = pane.x + (sheet.cols.offsetOf(brCol + 1) - pane.originX) * z;
    const y1 = pane.y + (sheet.rows.offsetOf(brRow + 1) - pane.originY) * z;
    return { x: tl.x, y: tl.y, width: x1 - tl.x, height: y1 - tl.y };
  };
  // Selected headers.
  if (vp.headerHeight > 0) {
    ctx.fillStyle = theme.headerSelectedBackground;
    ctx.globalAlpha = theme.forcedColors ? 1 : 0.6;
    for (const pane of vp.panes) {
      for (const zone of selection.zones) {
        const r = zoneRect(pane, zone);
        if (pane.name === 'main' || pane.name === 'top') {
          const a = intersect(
            { x: r.x, y: 0, width: r.width, height: vp.headerHeight },
            { x: pane.x, y: 0, width: pane.width, height: vp.headerHeight },
          );
          if (a) ctx.fillRect(a.x, a.y, a.width, a.height);
        }
        if (pane.name === 'main' || pane.name === 'left') {
          const a = intersect(
            { x: 0, y: r.y, width: vp.headerWidth, height: r.height },
            { x: 0, y: pane.y, width: vp.headerWidth, height: pane.height },
          );
          if (a) ctx.fillRect(a.x, a.y, a.width, a.height);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  const last = selection.zones[selection.zones.length - 1];
  for (const pane of vp.panes) {
    ctx.save();
    clipTo(ctx, pane);
    for (const zone of selection.zones) {
      const r = zoneRect(pane, zone);
      const single =
        zone.top === zone.bottom && zone.left === zone.right && selection.zones.length === 1;
      if (!single && !theme.forcedColors) {
        ctx.fillStyle = theme.selectionFill;
        ctx.globalAlpha = SELECTION_ALPHA;
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.globalAlpha = 1;
      }
      if (zone === last || theme.forcedColors) {
        ctx.strokeStyle = theme.selectionBorder;
        ctx.lineWidth = theme.forcedColors ? 2 : 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1);
      }
    }
    const merge = sheet.mergeAt(selection.active.row, selection.active.col);
    const active = zoneRect(
      pane,
      merge ?? {
        top: selection.active.row,
        left: selection.active.col,
        bottom: selection.active.row,
        right: selection.active.col,
      },
    );
    ctx.strokeStyle = theme.activeCellBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(active.x + 1, active.y + 1, active.width - 2, active.height - 2);
    if (input.mark && input.mark.sheet === sheet.id) {
      const m = zoneRect(pane, input.mark.zone);
      ctx.save();
      ctx.strokeStyle = theme.copyMarch;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(m.x + 1, m.y + 1, m.width - 2, m.height - 2);
      ctx.restore();
    }
    // Remote peers on this sheet: their zones outlined in their colour, a name tag on the active cell.
    for (const peer of input.remote ?? []) {
      if (peer.sheet !== sheet.id) continue;
      const color = theme.forcedColors ? theme.remoteUserColors[0] : peer.user.color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (const zone of peer.zones) {
        const r = zoneRect(pane, zone);
        ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
      }
      const at = zoneRect(pane, {
        top: peer.active.row,
        left: peer.active.col,
        bottom: peer.active.row,
        right: peer.active.col,
      });
      if (peer.editing !== undefined) {
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(at.x + 1, at.y + 1, at.width - 2, at.height - 2);
        ctx.setLineDash([]);
      }
      ctx.font = `${Math.max(9, theme.headerFontSize - 2) * z}px ${theme.fontFamily}`;
      const label = peer.editing !== undefined ? `${peer.user.name} (editing)` : peer.user.name;
      const w = ctx.measureText(label).width + 8;
      const h = 14 * z;
      const tagY = at.y - h >= pane.y ? at.y - h : at.y + at.height;
      ctx.fillStyle = color;
      ctx.fillRect(at.x, tagY, w, h);
      ctx.fillStyle = theme.forcedColors ? 'Canvas' : '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, at.x + 4, tagY + h / 2);
    }
    const lr = zoneRect(pane, last);
    ctx.fillStyle = theme.fillHandle;
    ctx.fillRect(
      lr.x + lr.width - FILL_HANDLE / 2 - 0.5,
      lr.y + lr.height - FILL_HANDLE / 2 - 0.5,
      FILL_HANDLE,
      FILL_HANDLE,
    );
    ctx.restore();
    drawLayers(input, 'overlay', pane, sheet, ctx);
  }
  ctx.restore();
}
