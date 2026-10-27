/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What a frame shows: the panes (corner, top, left, main, as frozen rows and
 * columns make them), the rows and columns each shows, and where they land on
 * the canvas. Pure, and O(log n + visible): offsets come from the axes'
 * Fenwick trees.
 *
 * Coordinates are CSS pixels at zoom 1 for content ("sheet px"), and canvas
 * CSS pixels for the view ("view px": sheet px × zoom).
 *
 * @module render/viewport
 */

import type { Axis } from '../core/axis.js';

export interface ViewportInput {
  readonly rows: Axis;
  readonly cols: Axis;
  readonly frozen: { readonly rows: number; readonly cols: number };
  /** Scroll of the scrolling panes, in sheet px, past the frozen part. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** The canvas's CSS size. */
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly showHeaders: boolean;
}

export interface Pane {
  readonly name: 'corner' | 'top' | 'left' | 'main';
  /** Where the pane sits on the canvas, view px. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The rows and columns it shows, inclusive; empty when `last < first`. */
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
  /** Sheet px of the pane's left and top edge: a cell at sheet x is drawn at `x + (sx - originX) * zoom`. */
  readonly originX: number;
  readonly originY: number;
}

export interface Viewport {
  readonly zoom: number;
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly panes: readonly Pane[];
  /** The scrolling part's extent, sheet px: what the scroll container's spacer stands for. */
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  /** The largest scroll the content allows. */
  readonly maxScrollX: number;
  readonly maxScrollY: number;
}

/** The header sizes at zoom 1. The row header widens with the digits of the last row. */
export function headerSizes(rowCount: number, show: boolean): { width: number; height: number } {
  if (!show) return { width: 0, height: 0 };
  const digits = String(rowCount).length;
  return { width: Math.max(40, 12 + digits * 8), height: 24 };
}

/** The indexes from `first` whose extent covers `span` sheet px, skipping hidden ones at the ends. */
function range(axis: Axis, from: number, span: number, limit: number): [number, number] {
  if (span <= 0 || limit <= 0 || from >= axis.offsetOf(limit)) return [0, -1];
  const first = axis.indexAt(from);
  const last = Math.min(axis.indexAt(Math.max(from, from + span - 1e-6)), limit - 1);
  return [first, last];
}

export function computeViewport(v: ViewportInput): Viewport {
  if (!(v.zoom > 0)) throw new Error(`A zoom must be positive; ${v.zoom} was given.`);
  const z = v.zoom;
  const header = headerSizes(v.rows.count, v.showHeaders);
  const hw = header.width * z;
  const hh = header.height * z;
  const frozenH = v.rows.offsetOf(v.frozen.rows);
  const frozenW = v.cols.offsetOf(v.frozen.cols);
  const scrollWidth = v.cols.extent - frozenW;
  const scrollHeight = v.rows.extent - frozenH;
  const bodyW = Math.max(0, v.width - hw);
  const bodyH = Math.max(0, v.height - hh);
  const fw = Math.min(frozenW * z, bodyW);
  const fh = Math.min(frozenH * z, bodyH);
  const mainW = bodyW - fw;
  const mainH = bodyH - fh;
  const maxScrollX = Math.max(0, scrollWidth - mainW / z);
  const maxScrollY = Math.max(0, scrollHeight - mainH / z);
  const sx = Math.min(Math.max(0, v.scrollX), maxScrollX);
  const sy = Math.min(Math.max(0, v.scrollY), maxScrollY);

  const frozenRows = range(v.rows, 0, fh / z, v.frozen.rows);
  const frozenCols = range(v.cols, 0, fw / z, v.frozen.cols);
  const rows = range(v.rows, frozenH + sy, mainH / z, v.rows.count);
  const cols = range(v.cols, frozenW + sx, mainW / z, v.cols.count);

  const pane = (
    name: Pane['name'],
    x: number,
    y: number,
    width: number,
    height: number,
    r: [number, number],
    c: [number, number],
    originX: number,
    originY: number,
  ): Pane => ({
    name,
    x,
    y,
    width,
    height,
    firstRow: r[0],
    lastRow: r[1],
    firstCol: c[0],
    lastCol: c[1],
    originX,
    originY,
  });

  const panes: Pane[] = [];
  if (fh > 0 && fw > 0) panes.push(pane('corner', hw, hh, fw, fh, frozenRows, frozenCols, 0, 0));
  if (fh > 0) panes.push(pane('top', hw + fw, hh, mainW, fh, frozenRows, cols, frozenW + sx, 0));
  if (fw > 0) panes.push(pane('left', hw, hh + fh, fw, mainH, rows, frozenCols, 0, frozenH + sy));
  panes.push(pane('main', hw + fw, hh + fh, mainW, mainH, rows, cols, frozenW + sx, frozenH + sy));
  return {
    zoom: z,
    headerWidth: hw,
    headerHeight: hh,
    panes,
    scrollWidth,
    scrollHeight,
    maxScrollX,
    maxScrollY,
  };
}

/** The pane under a canvas point, or `undefined` over the headers. */
export function paneAt(vp: Viewport, x: number, y: number): Pane | undefined {
  return vp.panes.find((p) => x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height);
}

/** The cell under a canvas point, or `undefined` over the headers or past the sheet. */
export function cellAt(
  vp: Viewport,
  rows: Axis,
  cols: Axis,
  x: number,
  y: number,
): { row: number; col: number } | undefined {
  const p = paneAt(vp, x, y);
  if (p === undefined) return undefined;
  const sx = p.originX + (x - p.x) / vp.zoom;
  const sy = p.originY + (y - p.y) / vp.zoom;
  if (sx >= cols.extent || sy >= rows.extent) return undefined;
  return { row: rows.indexAt(sy), col: cols.indexAt(sx) };
}

/** Where a cell's rectangle lands in a pane, view px (it may reach outside the pane). */
export function cellRect(p: Pane, zoom: number, rows: Axis, cols: Axis, row: number, col: number) {
  const x = p.x + (cols.offsetOf(col) - p.originX) * zoom;
  const y = p.y + (rows.offsetOf(row) - p.originY) * zoom;
  return {
    x,
    y,
    width: cols.effectiveSizeOf(col) * zoom,
    height: rows.effectiveSizeOf(row) * zoom,
  };
}

/** How near a header's edge (CSS px) a pointer grabs it to resize. */
export const EDGE_GRAB = 4;

/**
 * The header under a canvas point: which axis, which index, and the index
 * whose trailing edge is within reach (to resize it). `undefined` off the
 * headers and in the corner.
 */
export function headerAt(
  vp: Viewport,
  rows: Axis,
  cols: Axis,
  x: number,
  y: number,
): { axis: 'rows' | 'cols'; index: number; edge?: number; x: number; y: number } | undefined {
  if (vp.headerHeight === 0) return undefined;
  const inColumns = y < vp.headerHeight && x >= vp.headerWidth;
  const inRows = x < vp.headerWidth && y >= vp.headerHeight;
  if (!inColumns && !inRows) return undefined;
  const axis = inColumns ? 'cols' : 'rows';
  const a = inColumns ? cols : rows;
  const pane = vp.panes.find((p) =>
    inColumns ? x >= p.x && x < p.x + p.width : y >= p.y && y < p.y + p.height,
  );
  if (pane === undefined) return undefined;
  const local = inColumns
    ? pane.originX + (x - pane.x) / vp.zoom
    : pane.originY + (y - pane.y) / vp.zoom;
  if (local >= a.extent) return undefined;
  const index = a.indexAt(local);
  const start = a.offsetOf(index);
  const end = a.offsetOf(index + 1);
  const grab = EDGE_GRAB / vp.zoom;
  let edge: number | undefined;
  if (end - local <= grab) edge = index;
  else if (local - start <= grab && index > 0) {
    // The trailing edge of the previous visible index.
    let prev = index - 1;
    while (prev > 0 && a.effectiveSizeOf(prev) === 0) prev -= 1;
    edge = prev;
  }
  return { axis, index, edge, x, y };
}
