/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C6-04 (the overlay): a remote peer's selection is drawn in its colour on
 * the overlay, with a name tag on its active cell; a peer on another sheet
 * draws nothing; under forced colours the first remote colour is used.
 */

import { describe, expect, it } from 'vitest';
import { createCellsModel, type RemotePeer } from '../../core/index.js';
import { FORCED_COLORS_THEME } from '../theme.js';
import { headerSizes } from '../viewport.js';
import { paint, TEST_THEME } from './harness.js';

const pixel = (canvas: ReturnType<typeof paint>, x: number, y: number) => {
  const d = (canvas.getContext('2d') as unknown as CanvasRenderingContext2D).getImageData(
    Math.round(x),
    Math.round(y),
    1,
    1,
  ).data;
  return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

describe('remote presence on the overlay', () => {
  it('outlines a peer’s zone in its colour and tags its active cell with its name', () => {
    const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
    const s = m.sheet('s1');
    const { width: hw, height: hh } = headerSizes(s.rows.count, true);
    m.setRemotePresence([
      {
        id: '7',
        user: { name: 'Ada', color: '#ff0000' },
        sheet: 's1',
        zones: [{ top: 3, left: 2, bottom: 5, right: 3 }],
        active: { row: 3, col: 2 },
      },
    ]);
    const canvas = paint(m, { overlay: true, width: 600, height: 300 });
    const x = hw + s.cols.offsetOf(2);
    const y = hh + s.rows.offsetOf(4);
    expect(pixel(canvas, x + 1, y)).toBe('#ff0000'); // the zone's left edge, 2 px wide
    expect(pixel(canvas, x + 20, y)).not.toBe('#ff0000'); // inside the zone: no fill
    expect(pixel(canvas, x + 2, hh + s.rows.offsetOf(3) - 7)).toBe('#ff0000'); // the name tag above the active cell
  });

  it('draws nothing for a peer on another sheet, and uses the first remote colour under forced colours', () => {
    const m = createCellsModel({ limits: { rows: 50, cols: 10 } });
    m.dispatch({ type: 'ADD_SHEET', name: 'Other' });
    const other = m.sheets[1].id;
    const s = m.sheet('s1');
    const { width: hw, height: hh } = headerSizes(s.rows.count, true);
    const peer: RemotePeer = {
      id: '8',
      user: { name: 'Bob', color: '#00ff00' },
      sheet: other,
      zones: [{ top: 3, left: 2, bottom: 3, right: 2 }],
      active: { row: 3, col: 2 },
    };
    const x = hw + s.cols.offsetOf(2) + 1;
    const y = hh + s.rows.offsetOf(3) + 4;
    m.setRemotePresence([peer]);
    expect(pixel(paint(m, { overlay: true, width: 600, height: 300 }), x, y)).not.toBe('#00ff00');
    m.setRemotePresence([{ ...peer, sheet: 's1' }]);
    expect(pixel(paint(m, { overlay: true, width: 600, height: 300 }), x, y)).toBe('#00ff00');
    const forced = paint(m, {
      overlay: true,
      width: 600,
      height: 300,
      theme: {
        ...FORCED_COLORS_THEME,
        fontFamily: TEST_THEME.fontFamily,
        background: '#ffffff',
        headerBackground: '#eeeeee',
        remoteUserColors: ['#0000ff'],
      },
    });
    expect(pixel(forced, x, y)).toBe('#0000ff');
  });
});
