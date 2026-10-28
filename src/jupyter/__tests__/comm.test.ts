/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The page's side of the `datalayer.cells` comm (C11-09), on a fake kernel
 * connection: with a kernel that holds loro-py the page sends the
 * document's snapshot and every update and merges the kernel's updates
 * (what `datalayer_cells` wrote, read back on the page); without it the
 * page sends the workbook as JSON, again after a change, and applies the
 * kernel's writes as one transaction named after the cell.
 */

import { LoroDoc } from 'loro-crdt';
import { describe, expect, it, vi } from 'vitest';
import { LoroBinding } from '../../collab/binding.js';
import { createCellsModel } from '../../core/index.js';
import { openCellsComm } from '../comm.js';

/** A kernel connection whose comm records what the page sends and takes what the kernel answers. */
function connection() {
  const sent: Record<string, unknown>[] = [];
  const comm = {
    targetName: 'datalayer.cells',
    onMsg: undefined as ((msg: { content: { data: unknown } }) => void) | undefined,
    open: vi.fn(() => ({ done: Promise.resolve() })),
    send: vi.fn((data: Record<string, unknown>) => {
      sent.push(data);
      return { done: Promise.resolve() };
    }),
    close: vi.fn(() => ({ done: Promise.resolve() })),
  };
  const deliver = (data: Record<string, unknown>) => comm.onMsg?.({ content: { data } });
  return {
    sent,
    comm,
    deliver,
    createComm: vi.fn(() => comm),
  };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

function page() {
  const model = createCellsModel();
  model.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'Units'],
      ['Jan', 12],
    ],
  });
  const doc = new LoroDoc();
  doc.setPeerId(1);
  new LoroBinding(model, doc, { peer: '1' });
  return { model, doc };
}

describe('the datalayer.cells comm, on the page', () => {
  it('over Loro bytes: the snapshot, then every update, both ways', async () => {
    const { model, doc } = page();
    const c = connection();
    const open = openCellsComm(c as never as Parameters<typeof openCellsComm>[0], { model, doc });
    expect(c.createComm).toHaveBeenCalledWith('datalayer.cells');
    expect(c.comm.open).toHaveBeenCalledWith({ mode: 'loro' });
    c.deliver({ type: 'ready', mode: 'loro' });
    expect(await open.mode).toBe('loro');
    // The kernel's document is what the snapshot made it.
    const kernel = new LoroDoc();
    kernel.setPeerId(2);
    kernel.import(unb64(c.sent[0].data as string));
    expect(c.sent[0].type).toBe('snapshot');
    expect(kernel.getMap('cells:s1').toJSON()).toEqual(doc.getMap('cells:s1').toJSON());
    // A page edit reaches the kernel as an update.
    model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [[13]] });
    const update = c.sent.find((m, i) => i > 0 && m.type === 'update')!;
    kernel.import(unb64(update.data as string));
    expect(kernel.getMap('cells:s1').toJSON()).toEqual(doc.getMap('cells:s1').toJSON());
    // The kernel's write (as datalayer_cells stores it: the cell's ids, the value under v) shows on the page.
    const before = kernel.oplogVersion();
    kernel.getMap('cells:s1').set('b2.b2', { v: 42 });
    kernel.commit();
    c.deliver({ type: 'update', data: b64(kernel.export({ mode: 'update', from: before })) });
    expect(model.value('s1', 2, 2)).toBe(42);
    open.close();
    expect(c.comm.close).toHaveBeenCalled();
  });

  it('as JSON, for a kernel without loro-py: the workbook, again after a change, and the writes back', async () => {
    vi.useFakeTimers();
    try {
      const { model } = page();
      const c = connection();
      const open = openCellsComm(c as never as Parameters<typeof openCellsComm>[0], { model });
      expect(c.comm.open).toHaveBeenCalledWith({ mode: 'json' });
      c.deliver({ type: 'ready', mode: 'json' });
      expect(await open.mode).toBe('json');
      expect(c.sent[0]).toEqual({ type: 'snapshot', workbook: model.toJSON() });
      model.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 1, col: 1 }, cells: [[13]] });
      vi.advanceTimersByTime(150);
      expect(c.sent[1]).toEqual({ type: 'workbook', workbook: model.toJSON() });
      c.deliver({
        type: 'write',
        sheet: 's1',
        origin: 'Sheet1!C3',
        cells: [
          [2, 2, 42],
          [3, 2, 'x'],
        ],
      });
      expect(model.value('s1', 2, 2)).toBe(42);
      expect(model.value('s1', 3, 2)).toBe('x');
      // One undo step, named after the cell; and not echoed back as the page's own change.
      model.undo();
      expect(model.value('s1', 2, 2)).toBeNull();
      expect(model.value('s1', 3, 2)).toBeNull();
      open.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
