/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Painting in Node, for the snapshot suite: `@napi-rs/canvas` with a vendored
 * font (DejaVu Sans, tests/render/fonts), so the pixels do not depend on the
 * fonts a machine happens to have.
 */

import { createCanvas, GlobalFonts, loadImage, type Canvas } from '@napi-rs/canvas';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CellsModel } from '../../core/model.js';
import { TextMeasure } from '../lru.js';
import { type Ctx, paintGrid, paintOverlay } from '../paint.js';
import { type CellsTheme, LIGHT_THEME } from '../theme.js';
import { computeViewport } from '../viewport.js';

const TESTS = fileURLToPath(new URL('../../../tests/render/', import.meta.url));
GlobalFonts.registerFromPath(join(TESTS, 'fonts/DejaVuSans.ttf'), 'TestSans');
GlobalFonts.registerFromPath(join(TESTS, 'fonts/DejaVuSans-Bold.ttf'), 'TestSans');

export const TEST_THEME: CellsTheme = { ...LIGHT_THEME, fontFamily: 'TestSans' };

export interface Shot {
  width?: number;
  height?: number;
  dpr?: number;
  zoom?: number;
  scrollX?: number;
  scrollY?: number;
  sheet?: string;
  theme?: CellsTheme;
  showGridlines?: boolean;
  showHeaders?: boolean;
  overlay?: boolean;
}

/** Paint a model's sheet as the renderer would, into one canvas: the grid, then the overlay over it. */
export function paint(model: CellsModel, shot: Shot = {}): Canvas {
  const width = shot.width ?? 480;
  const height = shot.height ?? 240;
  const dpr = shot.dpr ?? 1;
  const sheet = model.sheet(shot.sheet ?? model.selection.sheet);
  const viewport = computeViewport({
    rows: sheet.rows,
    cols: sheet.cols,
    frozen: sheet.frozen,
    scrollX: shot.scrollX ?? 0,
    scrollY: shot.scrollY ?? 0,
    width,
    height,
    zoom: shot.zoom ?? 1,
    showHeaders: shot.showHeaders ?? true,
  });
  const canvas = createCanvas(width * dpr, height * dpr);
  const ctx = canvas.getContext('2d') as unknown as Ctx;
  const theme = shot.theme ?? TEST_THEME;
  paintGrid({
    ctx,
    dpr,
    viewport,
    sheet,
    styles: model.workbook.styles,
    theme,
    measure: new TextMeasure(),
    showGridlines: shot.showGridlines ?? true,
    value: (row, col) => model.value(sheet.id, row, col),
  });
  if (shot.overlay) {
    const overlay = createCanvas(width * dpr, height * dpr);
    paintOverlay({
      ctx: overlay.getContext('2d') as unknown as Ctx,
      dpr,
      viewport,
      sheet,
      theme,
      selection: model.selection,
    });
    (ctx as unknown as { drawImage(c: Canvas, x: number, y: number): void }).drawImage(
      overlay,
      0,
      0,
    );
  }
  return canvas;
}

/**
 * Compare a canvas with its snapshot (tests/render/snapshots/<name>.png).
 * A missing snapshot fails, unless CELLS_UPDATE_SNAPSHOTS=1 writes it. Two
 * pixels differ when a channel differs by more than 48; the snapshot holds when
 * at most 0.3 % of pixels differ (antialiasing across platforms).
 */
export async function expectSnapshot(
  canvas: Canvas,
  name: string,
): Promise<{ differing: number; total: number }> {
  const dir = join(TESTS, 'snapshots');
  const path = join(dir, `${name}.png`);
  const png = canvas.toBuffer('image/png');
  if (process.env.CELLS_UPDATE_SNAPSHOTS === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, png);
    return { differing: 0, total: canvas.width * canvas.height };
  }
  if (!existsSync(path))
    throw new Error(`No snapshot ${name}.png; run with CELLS_UPDATE_SNAPSHOTS=1 and look at it.`);
  const image = await loadImage(readFileSync(path));
  if (image.width !== canvas.width || image.height !== canvas.height) {
    throw new Error(
      `${name}: ${canvas.width}×${canvas.height}, the snapshot is ${image.width}×${image.height}.`,
    );
  }
  const ref = createCanvas(image.width, image.height);
  const rctx = ref.getContext('2d');
  rctx.drawImage(image, 0, 0);
  const a = (canvas.getContext('2d') as unknown as CanvasRenderingContext2D).getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  ).data;
  const b = rctx.getImageData(0, 0, ref.width, ref.height).data;
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 48 ||
      Math.abs(a[i + 1] - b[i + 1]) > 48 ||
      Math.abs(a[i + 2] - b[i + 2]) > 48
    )
      differing += 1;
  }
  const total = canvas.width * canvas.height;
  if (differing > total * 0.003) {
    const out = join(dir, `${name}.actual.png`);
    writeFileSync(out, png);
    throw new Error(
      `${name}: ${differing} of ${total} pixels differ from the snapshot; this frame is in ${out}.`,
    );
  }
  return { differing, total };
}
