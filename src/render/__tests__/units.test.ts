/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { describe, expect, it } from 'vitest';
import { Axis } from '../../core/axis.js';
import { Lru } from '../lru.js';
import { display, general } from '../numberFormat.js';
import { ScrollMapper, SPACER_CAP, spacerSize } from '../scroll.js';
import { cellAt, computeViewport } from '../viewport.js';

describe('the viewport', () => {
  const rows = new Axis({ count: 1_048_576, defaultSize: 21 });
  const cols = new Axis({ count: 16_384, defaultSize: 100 });

  it('shows what fits from the scroll position, in O(log n)', () => {
    const vp = computeViewport({
      rows,
      cols,
      frozen: { rows: 0, cols: 0 },
      scrollX: 0,
      scrollY: 21 * 500_000,
      width: 1920,
      height: 1080,
      zoom: 1,
      showHeaders: true,
    });
    const main = vp.panes[0];
    expect(main.firstRow).toBe(500_000);
    expect(main.lastRow - main.firstRow).toBe(Math.ceil((1080 - 24) / 21) - 1);
    expect(main.lastCol).toBe(Math.ceil((1920 - vp.headerWidth) / 100) - 1);
  });

  it('hit-tests a point to its cell, through panes and zoom', () => {
    const vp = computeViewport({
      rows,
      cols,
      frozen: { rows: 2, cols: 1 },
      scrollX: 300,
      scrollY: 210,
      width: 800,
      height: 600,
      zoom: 2,
      showHeaders: true,
    });
    // Inside the corner: row 0, col 0.
    expect(cellAt(vp, rows, cols, vp.headerWidth + 5, vp.headerHeight + 5)).toEqual({
      row: 0,
      col: 0,
    });
    // Main pane's top-left: past the frozen 2 rows and 1 column, scrolled 210 px (10 rows) and 300 px (3 columns).
    const main = vp.panes.find((p) => p.name === 'main')!;
    expect(cellAt(vp, rows, cols, main.x + 1, main.y + 1)).toEqual({ row: 12, col: 4 });
    expect(cellAt(vp, rows, cols, 5, 5)).toBeUndefined();
  });

  it('handles the last rows of the sheet', () => {
    const vp = computeViewport({
      rows,
      cols,
      frozen: { rows: 0, cols: 0 },
      scrollX: 0,
      scrollY: Infinity,
      width: 400,
      height: 300,
      zoom: 1,
      showHeaders: true,
    });
    expect(vp.panes[0].lastRow).toBe(1_048_575);
  });
});

describe('the scroll mapping', () => {
  it('is the identity under the cap', () => {
    const m = new ScrollMapper();
    expect(m.map(1234, { maxContent: 100_000, viewport: 800 })).toBe(1234);
  });

  it('above the cap, maps jumps linearly, steps exactly and the ends to the ends', () => {
    const axis = { maxContent: 22_000_000, viewport: 1000 };
    expect(spacerSize(axis.maxContent, axis.viewport)).toBe(SPACER_CAP);
    const m = new ScrollMapper();
    const maxDom = SPACER_CAP - 1000;
    const mid = m.map(maxDom / 2, axis);
    expect(mid).toBeCloseTo(11_000_000, -1);
    expect(m.map(maxDom / 2 + 1, axis)).toBe(mid + 1); // a 1 px step is 1 px
    expect(m.map(maxDom, axis)).toBe(22_000_000);
    expect(m.map(0, axis)).toBe(0);
  });
});

describe('the LRU', () => {
  it('evicts the least recently used past its capacity, and counts hits', () => {
    const l = new Lru<string, number>(2);
    l.set('a', 1);
    l.set('b', 2);
    l.get('a');
    l.set('c', 3);
    expect(l.get('b')).toBeUndefined();
    expect(l.get('a')).toBe(1);
    expect(l.size).toBe(2);
    expect(l.hits).toBe(2);
  });
});

describe('the built-in number formats', () => {
  it.each([
    [1234.5, 'General', '1234.5'],
    [1 / 3, 'General', '0.333333333'],
    [123456789012345, 'General', '1.23457E+14'],
    [1234.5, '#,##0.00', '1,234.50'],
    [-1234.567, '#,##0', '-1,235'],
    [0.256, '0.00%', '25.60%'],
    [45000, 'yyyy-mm-dd', '2023-03-15'],
    [0.75, 'hh:mm', '18:00'],
  ])('%s as %s is %s', (value, format, text) => {
    expect(display(value, format).text).toBe(text);
  });

  it('aligns by kind', () => {
    expect(display('x').align).toBe('left');
    expect(display(1).align).toBe('right');
    expect(display(true).align).toBe('center');
    expect(display({ error: '#N/A' }).text).toBe('#N/A');
    expect(general(0)).toBe('0');
  });
});
