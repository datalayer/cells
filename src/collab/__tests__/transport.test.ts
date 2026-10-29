/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * C6-01: the shared transport. lexical-loro's `transport` entry is imported
 * with `lexical` mocked to throw, so nothing of Lexical is reached; two
 * models join a room on the extracted `ws` server (started in-process) and
 * see each other's cells; two documents bridged in one page do too.
 */

import { LoroDoc } from 'loro-crdt';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCellsModel } from '../../core/index.js';
import {
  bindRoom,
  bridgeDocs,
  cellsWsCollabPlugin,
  joinRoom,
  ROOM_KEEPALIVE_MS,
} from '../transport.js';
import { LoroBinding } from '../binding.js';
import { CellsCollabProvider } from '../../points/index.js';

vi.mock('lexical', () => {
  throw new Error('lexical was imported: the transport is not Lexical-free');
});

// The rooms server of scripts/collab-server.mjs, on a free port.
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

const poll = <T>(read: () => T, want: T) =>
  expect.poll(read, { timeout: 10_000, interval: 20 }).toEqual(want);

describe('the shared transport', () => {
  it('imports lexical-loro’s transport and server entries without reaching lexical', async () => {
    const transport = await import('@datalayer/lexical-loro/lib/collab/loro/transport/index.js');
    expect(typeof transport.WebsocketProvider).toBe('function');
    const server = await import('@datalayer/lexical-loro/lib/collab/loro/transport/server.js');
    expect(typeof server.setupWSConnection).toBe('function');
  });

  it('an idle room stays connected: the socket hears from the server well within the 30 s it is given', async () => {
    // lexical-loro's provider drops a socket that received nothing for 30 s; Cells asks the
    // room's presence every ROOM_KEEPALIVE_MS, and the answer keeps the socket alive.
    expect(ROOM_KEEPALIVE_MS).toBeGreaterThan(0);
    expect(ROOM_KEEPALIVE_MS).toBeLessThanOrEqual(10_000);
    const joined = await joinRoom({
      url: rooms.url,
      room: `idle${Date.now()}`,
      doc: new LoroDoc(),
      WebSocketPolyfill: WebSocket,
      keepAliveMs: 100,
    });
    try {
      const heard = () =>
        (joined.provider as unknown as { wsLastMessageReceived: number }).wsLastMessageReceived;
      // Idle: nothing is edited; the last message heard keeps moving.
      await new Promise((r) => setTimeout(r, 600));
      const first = heard();
      await new Promise((r) => setTimeout(r, 600));
      expect(heard()).toBeGreaterThan(first);
      expect(Date.now() - heard()).toBeLessThan(500);
    } finally {
      joined.leave();
    }
  });

  it('two models in one room on the ws server see each other’s cells; a late peer adopts the room', async () => {
    const room = `r${Date.now()}`;
    const a = createCellsModel({ limits: { rows: 100, cols: 10 } });
    const joinedA = await bindRoom(a, {
      url: rooms.url,
      room,
      doc: new LoroDoc(),
      peer: 'a',
      WebSocketPolyfill: WebSocket,
      user: { name: 'Ada', color: '#0969da' },
    });
    a.dispatch({
      type: 'SET_CELLS',
      sheet: a.sheets[0].id,
      at: { row: 0, col: 0 },
      cells: [['shared', 42]],
    });
    const b = createCellsModel({ limits: { rows: 100, cols: 10 } });
    const joinedB = await bindRoom(b, {
      url: rooms.url,
      room,
      doc: new LoroDoc(),
      peer: 'b',
      WebSocketPolyfill: WebSocket,
    });
    // The late peer adopted the room's sheet, not its own seed.
    await poll(
      () => b.sheets.map((s) => s.id),
      a.sheets.map((s) => s.id),
    );
    await poll(() => b.value(b.sheets[0].id, 0, 0), 'shared');
    expect(b.value(b.sheets[0].id, 0, 1)).toBe(42);
    // And back the other way.
    b.dispatch({
      type: 'SET_CELLS',
      sheet: b.sheets[0].id,
      at: { row: 1, col: 0 },
      cells: [['from b']],
    });
    await poll(() => a.value(a.sheets[0].id, 1, 0), 'from b');
    // Presence over the wire (the awareness' states) is C6-04's, not this box's.
    joinedA.binding.dispose();
    joinedB.binding.dispose();
    joinedA.room.leave();
    joinedB.room.leave();
  }, 20_000);

  it('joining an unreachable server rejects after the timeout', async () => {
    await expect(
      joinRoom({
        url: 'ws://127.0.0.1:1',
        room: 'nowhere',
        doc: new LoroDoc(),
        WebSocketPolyfill: WebSocket,
        timeout: 300,
      }),
    ).rejects.toThrow(/No sync from ws:\/\/127\.0\.0\.1:1\/nowhere within 300 ms/);
  });

  it('two documents bridged in one page are each other’s peer', () => {
    const a = createCellsModel({ limits: { rows: 100, cols: 10 } });
    const b = createCellsModel({ limits: { rows: 100, cols: 10 } });
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    const stop = bridgeDocs(docA, docB);
    const ba = new LoroBinding(a, docA, { peer: 'a' });
    const bb = new LoroBinding(b, docB, { peer: 'b' });
    a.dispatch({
      type: 'SET_CELLS',
      sheet: a.sheets[0].id,
      at: { row: 0, col: 0 },
      cells: [['hello']],
    });
    expect(b.value(b.sheets[0].id, 0, 0)).toBe('hello');
    b.dispatch({ type: 'SET_CELLS', sheet: b.sheets[0].id, at: { row: 0, col: 1 }, cells: [[7]] });
    expect(a.value(a.sheets[0].id, 0, 1)).toBe(7);
    stop();
    a.dispatch({
      type: 'SET_CELLS',
      sheet: a.sheets[0].id,
      at: { row: 2, col: 0 },
      cells: [['alone']],
    });
    expect(b.value(b.sheets[0].id, 2, 0)).toBeNull();
    ba.dispose();
    bb.dispose();
  });

  it('cellsWsCollabPlugin contributes the one collaboration provider', () => {
    const m = createCellsModel({ plugins: [cellsWsCollabPlugin('ws://127.0.0.1:1236')] });
    const [provider] = m.reactor.getContributions(CellsCollabProvider);
    expect(provider.value.id).toBe('lexical-loro-ws');
    expect(provider.plugin).toBe('@datalayer/cells-collab-ws');
  });
});
