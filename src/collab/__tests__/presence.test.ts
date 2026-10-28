/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C6-04 (the unit part): presence. A selection travels in id form (so a
 * peer's insert above it leaves it on the same cells), the awareness carries
 * it over the rooms server with the user's name and colour, and the other
 * peer's model holds it as `remotePresence`, with the cell being edited and
 * the selected chart.
 */

import { LoroDoc } from 'loro-crdt';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCellsModel } from '../../core/index.js';
import { LoroBinding } from '../binding.js';
import { bindRoom } from '../transport.js';

let rooms: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  // @ts-expect-error -- a script, no declarations
  const { startRoomsServer } = (await import('../../../scripts/collab-server.mjs')) as {
    startRoomsServer: (o: { port: number }) => Promise<typeof rooms>;
  };
  rooms = await startRoomsServer({ port: 0 });
});
afterAll(async () => {
  await rooms.close();
});

const LIMITS = { rows: 100, cols: 20 };
const select = (
  m: ReturnType<typeof createCellsModel>,
  top: number,
  left: number,
  bottom: number,
  right: number,
) =>
  m.select({
    sheet: m.sheets[0].id,
    zones: [{ top, left, bottom, right }],
    anchor: { row: top, col: left },
    active: { row: top, col: left },
  });

describe('presence', () => {
  it('a selection in id form survives a row inserted above it by the other peer', () => {
    const a = createCellsModel({ limits: LIMITS });
    const b = createCellsModel({ limits: LIMITS });
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    docA.setPeerId(1);
    docB.setPeerId(2);
    const ba = new LoroBinding(a, docA, { peer: '1' });
    docB.import(docA.export({ mode: 'snapshot' }));
    const bb = new LoroBinding(b, docB, { peer: '2' });
    select(a, 1, 1, 2, 2); // B2:C3
    const ids = ba.selectionToIds(a.selection);
    expect(ids.sheet).toBe('s1');
    expect(bb.selectionFromIds(ids)).toMatchObject({
      zones: [{ top: 1, left: 1, bottom: 2, right: 2 }],
      active: { row: 1, col: 1 },
    });
    b.dispatch({ type: 'INSERT_AXIS', sheet: 's1', axis: 'rows', at: 0, n: 1 });
    docA.import(docB.export({ mode: 'update', from: docA.oplogVersion() }));
    // On both peers the same cells, now one row down.
    expect(bb.selectionFromIds(ids)).toMatchObject({
      zones: [{ top: 2, left: 1, bottom: 3, right: 2 }],
      active: { row: 2, col: 1 },
    });
    expect(ba.selectionFromIds(ids)).toMatchObject({
      zones: [{ top: 2, left: 1, bottom: 3, right: 2 }],
    });
    b.dispatch({ type: 'DELETE_AXIS', sheet: 's1', axis: 'rows', at: 2, n: 1 });
    expect(bb.selectionFromIds(ids)).toBeUndefined(); // its active cell is gone
    ba.dispose();
    bb.dispose();
  });

  it('two peers in a room see each other’s selection, name and colour, the cell being edited and the selected chart', async () => {
    const room = `p${Date.now()}`;
    const a = createCellsModel({ limits: LIMITS });
    a.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 0 },
      cells: [
        ['x', 1],
        ['y', 2],
        ['z', 3],
      ],
    });
    const ja = await bindRoom(a, {
      url: rooms.url,
      room,
      doc: new LoroDoc(),
      peer: 'a',
      WebSocketPolyfill: WebSocket,
      user: { name: 'Ada', color: '#0969da' },
    });
    const b = createCellsModel({ limits: LIMITS });
    const jb = await bindRoom(b, {
      url: rooms.url,
      room,
      doc: new LoroDoc(),
      peer: 'b',
      WebSocketPolyfill: WebSocket,
      user: { name: 'Bob', color: '#bf3989' },
    });
    const poll = <T>(read: () => T, want: T) =>
      expect.poll(read, { timeout: 10_000, interval: 25 }).toEqual(want);
    select(a, 1, 1, 2, 1); // B2:B3
    await poll(
      () => b.remotePresence.map((p) => [p.user.name, p.user.color, p.zones, p.active]),
      [['Ada', '#0969da', [{ top: 1, left: 1, bottom: 2, right: 1 }], { row: 1, col: 1 }]],
    );
    await poll(() => a.remotePresence.map((p) => p.user.name), ['Bob']);
    // Editing, and a selected chart.
    a.startEdit({ row: 2, col: 1 });
    await poll(() => b.remotePresence[0]?.editing, { row: 2, col: 1 });
    a.cancelEdit();
    await poll(() => b.remotePresence[0]?.editing, undefined);
    a.dispatch({
      type: 'INSERT_CHART',
      sheet: 's1',
      chart: {
        id: 'c1',
        type: 'column',
        anchor: {
          kind: 'cells',
          from: { row: 0, col: 3, dx: 0, dy: 0 },
          to: { row: 8, col: 8, dx: 0, dy: 0 },
        },
        data: {
          series: [{ values: 'Sheet1!$B$1:$B$3' }],
          by: 'columns',
          headers: { row: false, column: false },
          blanks: 'gap',
        },
        legend: 'none',
      },
    });
    a.selectChart('c1');
    await poll(() => b.remotePresence[0]?.chart, 'c1');
    // Leaving clears the other side's view of the peer.
    ja.stopPresence();
    ja.binding.dispose();
    ja.room.leave();
    await poll(() => b.remotePresence.length, 0);
    jb.stopPresence();
    jb.binding.dispose();
    jb.room.leave();
  }, 30_000);
});
