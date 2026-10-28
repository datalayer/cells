/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The paint rules, one snapshot each, drawn by `@napi-rs/canvas` in Node.
 * CELLS_UPDATE_SNAPSHOTS=1 rewrites them; look at every one you rewrite.
 */

import { describe, expect, it } from 'vitest';
import { type CellsModel, createCellsModel, type Style } from '../../core/index.js';
import { exportPortableTheme } from '@datalayer/primer-addons/lib/theme/portable';
import { themeFromVariables } from '../../react/theme.js';
import { DARK_THEME, FORCED_COLORS_THEME } from '../theme.js';
import { expectSnapshot, paint, TEST_THEME } from './harness.js';

function model(rows: unknown[][], styles: Record<string, Style> = {}): CellsModel {
  const m = createCellsModel({ limits: { rows: 200, cols: 30 } });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: rows as never });
  for (const [ref, style] of Object.entries(styles)) {
    const [col, row] = [ref.charCodeAt(0) - 65, Number(ref.slice(1)) - 1];
    expect(
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: row, left: col, bottom: row, right: col },
        style,
      }).ok,
    ).toBe(true);
  }
  return m;
}

describe('the paint rules', async () => {
  it('aligns by type: numbers right, text left, booleans and errors centred', async () => {
    const m = model([
      ['text', 42, true, { error: '#DIV/0!' }],
      ['more', -3.5, false, { error: '#N/A' }],
      [null, { formula: 'A1*2' }],
    ]);
    await expectSnapshot(paint(m), 'values');
  });

  it('overflows text into empty neighbours, stops at a filled one, and shows #### for a number too wide', async () => {
    const m = model(
      [
        ['This sentence runs over three empty cells', null, null, null, 'stop'],
        ['Blocked by the next cell', 'x'],
        [null, null, 'Right-aligned text runs left'],
        [12345678901234],
        [null, 'Centred text spreads both ways', null],
      ],
      { C3: { align: 'right' }, B5: { align: 'center' }, A4: { format: '#,##0.00' } },
    );
    await expectSnapshot(paint(m), 'overflow');
  });

  it('draws a merge over the grid lines it hides, with its top-left content', async () => {
    const m = model([['Merged title'], [], [1, 2, 3]], {
      A1: { fill: '#fff8c5', align: 'center', valign: 'middle', bold: true },
    });
    m.dispatch({ type: 'MERGE', sheet: 's1', zone: { top: 0, left: 0, bottom: 1, right: 2 } });
    await expectSnapshot(paint(m), 'merges');
  });

  it('draws borders: thin, medium, thick, dashed, dotted, double', async () => {
    const m = model([[1, 2, 3, 4, 5, 6]]);
    const sides = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'] as const;
    sides.forEach((style, c) =>
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 1, left: c, bottom: 1, right: c },
        style: {
          borders: { top: { style, color: '#cf222e' }, bottom: { style, color: '#0969da' } },
        },
      }),
    );
    await expectSnapshot(paint(m), 'borders');
  });

  it('draws the built-in cell types: checkbox, link and progress bar, in light and forced colours', async () => {
    const typed = () => {
      const m = model(
        [
          ['Done', 'Site', 'Progress'],
          [true, 'https://datalayer.io', 0.42],
          [false, 'plain words', 1],
          [1, 'www.example.org', 0],
          [{ error: '#N/A' }, null, 'n/a'],
          [{ formula: 'A2' }, { formula: 'B2' }, { formula: 'C2*2' }],
        ],
        { A1: { bold: true }, B1: { bold: true }, C1: { bold: true } },
      );
      for (const [col, type] of [
        [0, 'checkbox'],
        [1, 'link'],
        [2, 'progress'],
      ] as const)
        m.dispatch({
          type: 'SET_STYLE',
          sheet: 's1',
          zone: { top: 1, left: col, bottom: 5, right: col },
          style: { type },
        });
      // A left-aligned checkbox with a fill, and a type no plugin contributes, drawn plain.
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 3, left: 0, bottom: 3, right: 0 },
        style: { align: 'left', fill: '#dafbe1' },
      });
      m.dispatch({
        type: 'SET_STYLE',
        sheet: 's1',
        zone: { top: 3, left: 1, bottom: 3, right: 1 },
        style: { type: 'acme.stars' },
      });
      return m;
    };
    await expectSnapshot(paint(typed(), { width: 400, height: 160 }), 'cell-types');
    await expectSnapshot(
      paint(typed(), {
        width: 400,
        height: 160,
        // System colour names, which the Node canvas cannot parse, stand in as black on white.
        theme: {
          ...FORCED_COLORS_THEME,
          background: '#ffffff',
          text: '#000000',
          textMuted: '#808080',
          gridline: '#808080',
          headerBackground: '#ffffff',
          headerText: '#000000',
          headerBorder: '#000000',
          activeCellBorder: '#1a5fb4',
          linkText: '#0000ee',
          errorText: '#000000',
          fontFamily: 'TestSans',
        },
      }),
      'cell-types-forced',
    );
  });

  it('splits frozen panes, scrolls only the main pane, and draws the frozen edges', async () => {
    const rows = Array.from({ length: 60 }, (_, r) =>
      Array.from({ length: 12 }, (_, c) => (r === 0 ? `H${c}` : c === 0 ? `R${r}` : r * c)),
    );
    const m = model(rows);
    m.dispatch({ type: 'FREEZE', sheet: 's1', rows: 1, cols: 1 });
    await expectSnapshot(paint(m, { scrollX: 250, scrollY: 300 }), 'frozen');
  });

  it('stays crisp at DPR 2 and zoom 1.5', async () => {
    const m = model(
      [
        ['zoomed', 1.25],
        ['grid', 2],
      ],
      { A1: { bold: true } },
    );
    await expectSnapshot(paint(m, { dpr: 2, zoom: 1.5, width: 320, height: 160 }), 'dpr2-zoom150');
  });

  it('skips hidden rows and columns, and honours sizes', async () => {
    const m = model([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
      ['i', 'j', 'k', 'l'],
    ]);
    m.dispatch({ type: 'HIDE_AXIS', sheet: 's1', axis: 'rows', from: 1, to: 1, hidden: true });
    m.dispatch({ type: 'HIDE_AXIS', sheet: 's1', axis: 'cols', from: 1, to: 1, hidden: true });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 2, to: 2, size: 180 });
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'rows', from: 2, to: 2, size: 44 });
    await expectSnapshot(paint(m), 'hidden-sizes');
  });

  it('applies text styles: bold, italic, underline, strike, colour, fill, wrap, vertical alignment', async () => {
    const m = model(
      [
        ['bold', 'italic', 'underline', 'strike'],
        ['red', 'filled', 'This text wraps onto lines', 'top'],
      ],
      {
        A1: { bold: true },
        B1: { italic: true },
        C1: { underline: true },
        D1: { strike: true },
        A2: { color: '#cf222e' },
        B2: { fill: '#dafbe1' },
        C2: { wrap: true },
        D2: { valign: 'top' },
      },
    );
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'rows', from: 1, to: 1, size: 60 });
    await expectSnapshot(paint(m), 'styles');
  });

  it('shows the built-in number formats', async () => {
    const m = model(
      [[1234.5, 1234.5, 0.256, 46000.75, 46000.75, 0.000000000123, 123456789012345]],
      {
        A1: { format: '#,##0.00' },
        B1: { format: '0' },
        C1: { format: '0.00%' },
        D1: { format: 'yyyy-mm-dd' },
        E1: { format: 'hh:mm' },
      },
    );
    m.dispatch({ type: 'RESIZE_AXIS', sheet: 's1', axis: 'cols', from: 0, to: 6, size: 110 });
    await expectSnapshot(paint(m, { width: 820 }), 'formats');
  });

  it('draws the selection on the overlay: zones, the active cell, the fill handle, the headers', async () => {
    const m = model([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    m.select({
      sheet: 's1',
      zones: [
        { top: 0, left: 0, bottom: 0, right: 0 },
        { top: 1, left: 1, bottom: 3, right: 2 },
      ],
      anchor: { row: 1, col: 1 },
      active: { row: 2, col: 1 },
    });
    await expectSnapshot(paint(m, { overlay: true }), 'selection');
  });

  it('draws in the dark theme, and in forced colours with an outline for the selection', async () => {
    const m = model([
      ['dark', 1],
      ['theme', 2],
    ]);
    m.select({
      sheet: 's1',
      zones: [{ top: 0, left: 0, bottom: 1, right: 1 }],
      anchor: { row: 0, col: 0 },
      active: { row: 0, col: 0 },
    });
    await expectSnapshot(
      paint(m, { overlay: true, theme: { ...DARK_THEME, fontFamily: 'TestSans' } }),
      'theme-dark',
    );
    await expectSnapshot(
      paint(m, {
        overlay: true,
        theme: {
          ...FORCED_COLORS_THEME,
          background: '#ffffff',
          text: '#000000',
          gridline: '#808080',
          headerBackground: '#ffffff',
          headerText: '#000000',
          headerBorder: '#000000',
          selectionBorder: '#1a5fb4',
          activeCellBorder: '#1a5fb4',
          fillHandle: '#1a5fb4',
          headerSelectedBackground: '#1a5fb4',
          frozenLine: '#000000',
          errorText: '#000000',
          fontFamily: 'TestSans',
        },
      }),
      'theme-forced',
    );
  });

  for (const variant of ['loop', 'datalayer'] as const) {
    for (const mode of ['light', 'dark'] as const) {
      it(`draws in primer-addons' ${variant} theme, ${mode}`, async () => {
        const map = exportPortableTheme(variant).modes[mode] as Record<string, string>;
        const theme = {
          ...themeFromVariables((name) => map[name], mode === 'dark'),
          fontFamily: 'TestSans',
        };
        const m = model(
          [
            ['Region', 'Q1', 'Q2'],
            ['North', 120, 135],
            ['South', 98, { error: '#N/A' }],
          ],
          { A1: { bold: true } },
        );
        m.select({
          sheet: 's1',
          zones: [{ top: 1, left: 1, bottom: 2, right: 2 }],
          anchor: { row: 1, col: 1 },
          active: { row: 1, col: 1 },
        });
        await expectSnapshot(paint(m, { overlay: true, theme }), `theme-${variant}-${mode}`);
      });
    }
  }

  it('hides grid lines and headers when asked', async () => {
    const m = model([
      ['no', 'grid'],
      ['no', 'headers'],
    ]);
    await expectSnapshot(paint(m, { showGridlines: false, showHeaders: false }), 'bare');
  });

  it('keeps every pixel of a hairline on one device pixel', async () => {
    const m = model([[]]);
    const canvas = paint(m, { width: 200, height: 100, showHeaders: false });
    const data = (canvas.getContext('2d') as unknown as CanvasRenderingContext2D).getImageData(
      0,
      0,
      200,
      100,
    ).data;
    // The grid line under row 1 (21 px tall) sits on y = 20: one dark row, white rows around it.
    const at = (x: number, y: number) => data[(y * 200 + x) * 4];
    expect(at(50, 20)).toBeLessThan(230);
    expect(at(50, 19)).toBe(255);
    expect(at(50, 21)).toBe(255);
  });
});

void TEST_THEME;
