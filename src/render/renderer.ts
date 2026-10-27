/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The canvas renderer: a grid canvas and an overlay canvas, repainted in
 * frames. Changes (dirty rows from the model, scrolls, resizes) are queued
 * and coalesced into one animation frame; no frame is drawn when nothing is
 * dirty. A scroll smaller than the viewport copies the pixels the grid canvas
 * already has and paints only the exposed strips; an edit repaints only its
 * rows. Moving the selection repaints the overlay only.
 *
 * @module render/renderer
 */

import type { CellsModel, Transaction } from '../core/model.js';
import type { Patch } from '../core/patches.js';
import type { SelectionState } from '../core/selection.js';
import { EN_US, type NumberLocale } from '../core/numfmt.js';
import { TextMeasure } from './lru.js';
import { paintGrid, paintOverlay, type Ctx } from './paint.js';
import type { CellsTheme } from './theme.js';
import { computeViewport, type Viewport } from './viewport.js';

export interface RendererCounters {
  frames: number;
  /** Full repaints of the grid canvas. */
  gridFull: number;
  /** Partial repaints: exposed strips and dirty rows. */
  gridPartial: number;
  blits: number;
  overlay: number;
  /** Script time of the last frame, ms. */
  lastFrameMs: number;
  /** Cells and texts painted in the last frame. */
  cells: number;
  texts: number;
  /** The last frame's parts, ms: the blit, the grid painting, the overlay. */
  blitMs: number;
  gridMs: number;
  overlayMs: number;
}

export interface RendererOptions {
  readonly model: CellsModel;
  readonly grid: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly theme: CellsTheme;
  readonly showGridlines?: boolean;
  readonly showHeaders?: boolean;
  /** For tests: a frame scheduler other than requestAnimationFrame. */
  readonly schedule?: (frame: () => void) => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CanvasRenderer {
  readonly counters: RendererCounters = {
    frames: 0,
    gridFull: 0,
    gridPartial: 0,
    blits: 0,
    overlay: 0,
    lastFrameMs: 0,
    cells: 0,
    texts: 0,
    blitMs: 0,
    gridMs: 0,
    overlayMs: 0,
  };
  readonly measure = new TextMeasure();
  readonly #model: CellsModel;
  readonly #grid: HTMLCanvasElement;
  readonly #overlay: HTMLCanvasElement;
  readonly #schedule: (frame: () => void) => void;
  #theme: CellsTheme;
  #showGridlines: boolean;
  #showHeaders: boolean;
  #locale: NumberLocale = EN_US;
  #width = 0;
  #height = 0;
  #dpr = 1;
  #zoom = 1;
  #scrollX = 0;
  #scrollY = 0;
  #sheet: string;
  #viewport: Viewport | null = null;
  /** Pending work for the next frame. */
  #full = true;
  #overlayDirty = true;
  #dirty: Rect[] = [];
  #shift = { dx: 0, dy: 0 };
  #scheduled = false;
  #disposed = false;
  readonly #unsubscribe: () => void;

  constructor(options: RendererOptions) {
    this.#model = options.model;
    this.#grid = options.grid;
    this.#overlay = options.overlay;
    this.#theme = options.theme;
    this.#showGridlines = options.showGridlines ?? true;
    this.#showHeaders = options.showHeaders ?? true;
    this.#schedule = options.schedule ?? ((f) => requestAnimationFrame(f));
    this.#sheet = this.#model.selection.sheet;
    const a = this.#model.subscribe((tx) => this.#onChange(tx));
    const b = this.#model.subscribeSelection((s) => this.#onSelection(s));
    this.#unsubscribe = () => {
      a();
      b();
    };
  }

  /** Detach from the model; the model is left as it is. */
  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
  }

  get viewport(): Viewport {
    if (this.#viewport === null) this.#viewport = this.#computeViewport();
    return this.#viewport;
  }

  get sheet(): string {
    return this.#sheet;
  }

  get dpr(): number {
    return this.#dpr;
  }

  get zoom(): number {
    return this.#zoom;
  }

  get scroll(): { x: number; y: number } {
    return { x: this.#scrollX, y: this.#scrollY };
  }

  /** The canvases' CSS size and the device pixel ratio. Resizes the canvases only when one changes. */
  setSize(width: number, height: number, dpr: number): void {
    if (width === this.#width && height === this.#height && dpr === this.#dpr) return;
    this.#width = width;
    this.#height = height;
    this.#dpr = dpr;
    for (const c of [this.#grid, this.#overlay]) {
      c.width = Math.max(1, Math.round(width * dpr));
      c.height = Math.max(1, Math.round(height * dpr));
    }
    this.#invalidateAll();
  }

  setZoom(zoom: number): void {
    if (!(zoom >= 0.5 && zoom <= 4))
      throw new Error(`Zoom goes from 0.5 to 4; ${zoom} was asked for.`);
    if (zoom === this.#zoom) return;
    this.#zoom = zoom;
    this.#invalidateAll();
  }

  setTheme(theme: CellsTheme): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#invalidateAll();
  }

  setOptions(options: { showGridlines?: boolean; showHeaders?: boolean }): void {
    const g = options.showGridlines ?? this.#showGridlines;
    const h = options.showHeaders ?? this.#showHeaders;
    if (g === this.#showGridlines && h === this.#showHeaders) return;
    this.#showGridlines = g;
    this.#showHeaders = h;
    this.#invalidateAll();
  }

  /** The number locale cells are shown in. */
  setLocale(locale: NumberLocale): void {
    if (locale === this.#locale) return;
    this.#locale = locale;
    this.#invalidateAll();
  }

  setSheet(sheet: string): void {
    if (sheet === this.#sheet) return;
    this.#model.sheet(sheet);
    this.#sheet = sheet;
    this.#scrollX = 0;
    this.#scrollY = 0;
    this.#invalidateAll();
  }

  /** Scroll the scrolling panes to sheet px; small steps blit. */
  setScroll(x: number, y: number): void {
    const before = this.viewport;
    const sx = Math.min(Math.max(0, x), before.maxScrollX);
    const sy = Math.min(Math.max(0, y), before.maxScrollY);
    if (sx === this.#scrollX && sy === this.#scrollY) return;
    const dx = (sx - this.#scrollX) * this.#zoom;
    const dy = (sy - this.#scrollY) * this.#zoom;
    this.#scrollX = sx;
    this.#scrollY = sy;
    this.#viewport = null;
    if (!this.#full) {
      this.#shift = { dx: this.#shift.dx + dx, dy: this.#shift.dy + dy };
    }
    this.#overlayDirty = true;
    this.#request();
  }

  /** Repaint everything on the next frame. */
  repaint(): void {
    this.#invalidateAll();
  }

  /** Paint now what is pending (the frame callback; tests call it directly). */
  frame(): void {
    this.#scheduled = false;
    if (this.#disposed || this.#width === 0 || this.#height === 0) return;
    const t0 = performance.now();
    const vp = this.viewport;
    const sheet = this.#model.sheet(this.#sheet);
    const ctx = this.#grid.getContext('2d', { alpha: false, desynchronized: true }) as Ctx | null;
    if (ctx === null) throw new Error('The grid canvas has no 2D context.');
    const input = {
      ctx,
      dpr: this.#dpr,
      viewport: vp,
      sheet,
      styles: this.#model.workbook.styles,
      theme: this.#theme,
      measure: this.measure,
      showGridlines: this.#showGridlines,
      locale: this.#locale,
      value: (row: number, col: number) => this.#model.value(sheet.id, row, col),
    };
    let painted = { cells: 0, texts: 0 };
    const main = vp.panes.find((p) => p.name === 'main')!;
    const { dx, dy } = this.#shift;
    const blittable =
      !this.#full &&
      (dx !== 0 || dy !== 0) &&
      Math.abs(dx) < main.width / 2 &&
      Math.abs(dy) < main.height / 2;
    this.counters.blitMs = 0;
    const tGrid = performance.now();
    if (this.#full || (!blittable && (dx !== 0 || dy !== 0))) {
      painted = paintGrid(input);
      this.counters.gridFull += 1;
    } else {
      const strips: Rect[] = [...this.#dirty];
      if (blittable) {
        const tBlit = performance.now();
        this.#blit(ctx, main, dx, dy);
        this.counters.blitMs = performance.now() - tBlit;
        strips.push(...this.#exposed(main, dx, dy));
      }
      for (const clip of strips) {
        const p = paintGrid({ ...input, clip });
        painted.cells += p.cells;
        painted.texts += p.texts;
      }
      if (strips.length > 0) this.counters.gridPartial += 1;
    }
    this.counters.gridMs = performance.now() - tGrid - this.counters.blitMs;
    const tOverlay = performance.now();
    if (this.#overlayDirty || this.#full || dx !== 0 || dy !== 0 || this.#dirty.length > 0) {
      const octx = this.#overlay.getContext('2d', { desynchronized: true }) as Ctx | null;
      if (octx === null) throw new Error('The overlay canvas has no 2D context.');
      paintOverlay({
        ctx: octx,
        dpr: this.#dpr,
        viewport: vp,
        sheet,
        theme: this.#theme,
        selection: this.#model.selection,
        mark: this.#model.clipboardMark,
      });
      this.counters.overlay += 1;
    }
    this.counters.overlayMs = performance.now() - tOverlay;
    this.#full = false;
    this.#overlayDirty = false;
    this.#dirty = [];
    this.#shift = { dx: 0, dy: 0 };
    this.counters.frames += 1;
    if (this.counters.frames === 1 && typeof performance.mark === 'function')
      performance.mark('cells:first-frame');
    this.counters.cells = painted.cells;
    this.counters.texts = painted.texts;
    this.counters.lastFrameMs = performance.now() - t0;
  }

  /** Copy what the grid canvas already shows, shifted by a scroll. */
  #blit(
    ctx: Ctx,
    main: { x: number; y: number; width: number; height: number },
    dx: number,
    dy: number,
  ): void {
    const d = this.#dpr;
    const W = this.#width;
    const H = this.#height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (dx !== 0) {
      // The columns region (top pane, column header, main): everything right of main.x.
      const x = main.x;
      ctx.drawImage(
        this.#grid,
        (x + Math.max(dx, 0)) * d,
        0,
        (W - x - Math.abs(dx)) * d,
        H * d,
        (x + Math.max(-dx, 0)) * d,
        0,
        (W - x - Math.abs(dx)) * d,
        H * d,
      );
    }
    if (dy !== 0) {
      const y = main.y;
      ctx.drawImage(
        this.#grid,
        0,
        (y + Math.max(dy, 0)) * d,
        W * d,
        (H - y - Math.abs(dy)) * d,
        0,
        (y + Math.max(-dy, 0)) * d,
        W * d,
        (H - y - Math.abs(dy)) * d,
      );
    }
    ctx.restore();
    this.counters.blits += 1;
  }

  /** The strips a blit leaves to paint. */
  #exposed(
    main: { x: number; y: number; width: number; height: number },
    dx: number,
    dy: number,
  ): Rect[] {
    const out: Rect[] = [];
    const W = this.#width;
    const H = this.#height;
    if (dx > 0) out.push({ x: W - dx - 1, y: 0, width: dx + 1, height: H });
    if (dx < 0) out.push({ x: main.x, y: 0, width: -dx + 1, height: H });
    if (dy > 0) out.push({ x: 0, y: H - dy - 1, width: W, height: dy + 1 });
    if (dy < 0) out.push({ x: 0, y: main.y, width: W, height: -dy + 1 });
    return out;
  }

  #onChange(tx: Transaction): void {
    this.#viewport = null;
    if (!this.#model.workbook.hasSheet(this.#sheet)) this.#sheet = this.#model.selection.sheet;
    let rows =
      tx.origin === 'load' || tx.origin === 'plugins' || tx.origin === 'async'
        ? 'all'
        : rowsTouched(tx.patches, this.#sheet);
    // A changed cell may change any formula: the whole view, until the dependency graph says which.
    if (tx.patches.length > 0 && this.#model.workbook.formulas.size > 0) rows = 'all';
    if (rows === 'all') {
      this.#invalidateAll();
      return;
    }
    if (rows === 'none') {
      this.#overlayDirty = true;
      this.#request();
      return;
    }
    // A changed row is repainted across the whole width: text overflows sideways.
    const vp = this.viewport;
    const sheet = this.#model.sheet(this.#sheet);
    for (const pane of vp.panes) {
      const top = Math.max(rows.top, pane.firstRow);
      const bottom = Math.min(rows.bottom, pane.lastRow);
      if (top > bottom) continue;
      const y0 = pane.y + (sheet.rows.offsetOf(top) - pane.originY) * vp.zoom;
      const y1 = pane.y + (sheet.rows.offsetOf(bottom + 1) - pane.originY) * vp.zoom;
      this.#dirty.push({
        x: 0,
        y: Math.max(pane.y, y0 - 1),
        width: this.#width,
        height: Math.min(pane.y + pane.height, y1 + 1) - Math.max(pane.y, y0 - 1),
      });
    }
    this.#overlayDirty = true;
    this.#request();
  }

  #onSelection(s: SelectionState): void {
    if (s.sheet !== this.#sheet) {
      this.setSheet(s.sheet);
      return;
    }
    this.#overlayDirty = true;
    this.#request();
  }

  #invalidateAll(): void {
    this.#viewport = null;
    this.#full = true;
    this.#overlayDirty = true;
    this.#dirty = [];
    this.#shift = { dx: 0, dy: 0 };
    this.#request();
  }

  #request(): void {
    if (this.#scheduled || this.#disposed) return;
    this.#scheduled = true;
    this.#schedule(() => this.frame());
  }

  #computeViewport(): Viewport {
    const sheet = this.#model.sheet(this.#sheet);
    return computeViewport({
      rows: sheet.rows,
      cols: sheet.cols,
      frozen: sheet.frozen,
      scrollX: this.#scrollX,
      scrollY: this.#scrollY,
      width: this.#width,
      height: this.#height,
      zoom: this.#zoom,
      showHeaders: this.#showHeaders,
    });
  }
}

/** The rows of a sheet a transaction's patches touched: a band, nothing, or everything (structure, sizes, merges). */
export function rowsTouched(
  patches: readonly Patch[],
  sheet: string,
): { top: number; bottom: number } | 'none' | 'all' {
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of patches) {
    const s = (p as { sheet?: unknown }).sheet;
    if (p.op === 'cells') {
      if (s !== sheet) continue;
      const z = (p as unknown as { zone: { top: number; bottom: number } }).zone;
      top = Math.min(top, z.top);
      bottom = Math.max(bottom, z.bottom);
    } else if (typeof s === 'string' && s !== sheet) {
      continue;
    } else {
      return 'all';
    }
  }
  if (top === Infinity) return 'none';
  if (bottom - top > 200) return 'all';
  return { top, bottom };
}
