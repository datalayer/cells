/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { createCellsModel } from '../../core/index.js';
import { CanvasRenderer, rowsTouched } from '../renderer.js';
import { TEST_THEME } from './harness.js';

/** A renderer on Node canvases, with frames run by hand. */
function setup() {
  const model = createCellsModel({ limits: { rows: 100_000, cols: 50 } });
  const block = Array.from({ length: 200 }, (_, r) =>
    Array.from({ length: 10 }, (_, c) => r * 10 + c),
  );
  model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: block });
  const queue: (() => void)[] = [];
  const renderer = new CanvasRenderer({
    model,
    grid: createCanvas(1, 1) as unknown as HTMLCanvasElement,
    overlay: createCanvas(1, 1) as unknown as HTMLCanvasElement,
    theme: TEST_THEME,
    schedule: (f) => queue.push(f),
  });
  const flush = () => {
    const frames = queue.splice(0);
    for (const f of frames) f();
    return frames.length;
  };
  renderer.setSize(800, 600, 2);
  flush();
  return { model, renderer, flush };
}

describe('the canvas renderer', () => {
  it('paints the first frame in full, then nothing while nothing changes', () => {
    const { renderer, flush } = setup();
    expect(renderer.counters.gridFull).toBe(1);
    expect(flush()).toBe(0);
    expect(renderer.counters.frames).toBe(1);
  });

  it('repaints only the overlay when the selection moves', () => {
    const { model, renderer, flush } = setup();
    const before = { ...renderer.counters };
    model.select({
      sheet: 's1',
      zones: [{ top: 3, left: 3, bottom: 3, right: 3 }],
      anchor: { row: 3, col: 3 },
      active: { row: 3, col: 3 },
    });
    model.select({
      sheet: 's1',
      zones: [{ top: 4, left: 3, bottom: 4, right: 3 }],
      anchor: { row: 4, col: 3 },
      active: { row: 4, col: 3 },
    });
    expect(flush()).toBe(1); // coalesced into one frame
    expect(renderer.counters.gridFull).toBe(before.gridFull);
    expect(renderer.counters.gridPartial).toBe(before.gridPartial);
    expect(renderer.counters.overlay).toBe(before.overlay + 1);
  });

  it('repaints only the edited rows', () => {
    const { model, renderer, flush } = setup();
    const before = { ...renderer.counters };
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 5, col: 2 }, cells: [['edited']] });
    flush();
    expect(renderer.counters.gridFull).toBe(before.gridFull);
    expect(renderer.counters.gridPartial).toBe(before.gridPartial + 1);
    expect(renderer.counters.cells).toBeLessThan(40); // one row band, not the screen
  });

  it('blits a small scroll and paints only the exposed strip', () => {
    const { renderer, flush } = setup();
    const before = { ...renderer.counters };
    renderer.setScroll(0, 42);
    flush();
    expect(renderer.counters.blits).toBe(before.blits + 1);
    expect(renderer.counters.gridFull).toBe(before.gridFull);
    expect(renderer.counters.cells).toBeLessThan(40);
  });

  it('repaints in full after a jump, a resize, a zoom or a theme change', () => {
    const { renderer, flush } = setup();
    renderer.setScroll(0, 50_000);
    flush();
    expect(renderer.counters.gridFull).toBe(2);
    renderer.setSize(640, 480, 1);
    flush();
    renderer.setZoom(1.5);
    flush();
    renderer.setTheme({ ...TEST_THEME });
    flush();
    expect(renderer.counters.gridFull).toBe(5);
  });

  it('repaints in full after a structural change', () => {
    const { model, renderer, flush } = setup();
    model.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 });
    flush();
    expect(renderer.counters.gridFull).toBe(2);
  });

  it('stops listening once disposed, and leaves the model alone', () => {
    const { model, renderer, flush } = setup();
    renderer.dispose();
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [['x']] });
    expect(flush()).toBe(0);
    expect(model.value('s1', 0, 0)).toBe('x');
  });

  it('refuses a zoom outside 50 to 400 %', () => {
    const { renderer } = setup();
    expect(() => renderer.setZoom(5)).toThrow(/0.5 to 4/);
  });
});

describe('rowsTouched', () => {
  it('reads a band from cells patches, everything from structural ones', () => {
    const cells = (top: number, bottom: number, sheet = 's1') => ({
      op: 'cells',
      sheet,
      zone: { top, bottom, left: 0, right: 0 },
    });
    expect(rowsTouched([cells(3, 4), cells(9, 9)], 's1')).toEqual({ top: 3, bottom: 9 });
    expect(rowsTouched([cells(3, 4, 's2')], 's1')).toBe('none');
    expect(rowsTouched([{ op: 'axis-insert', sheet: 's1' } as never], 's1')).toBe('all');
    expect(rowsTouched([cells(0, 500)], 's1')).toBe('all');
  });
});
