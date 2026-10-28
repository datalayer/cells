/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * Every key the grid handles is a Reactor command's: the key reaches the
 * command through the grid's one keybinding lookup, and the command, run by
 * its id with no argument (as a palette runs it), does what the key does on
 * a twin grid. A host's keymap rebinds or unbinds a moved key.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CellsGridAccess,
  type CellsModel,
  createCellsModel,
  EDITING_COMMANDS,
  NAVIGATION_COMMANDS,
  Spreadsheet,
} from '../../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const canvas = this;
    return new Proxy(
      {},
      {
        get: (_t, key) => {
          if (key === 'canvas') return canvas;
          if (key === 'measureText') return (s: string) => ({ width: s.length * 7 });
          return () => undefined;
        },
        set: () => true,
      },
    ) as never;
  } as never;
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe() {
      this.cb([], this as never);
    }
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 800,
      height: 400,
      right: 800,
      bottom: 400,
      toJSON: () => ({}),
    } as DOMRect;
  };
  globalThis.requestAnimationFrame = (f: FrameRequestCallback) =>
    setTimeout(() => f(0), 0) as unknown as number;
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

/** A block of data in A1:D6 with a gap, the selection on B3 (B3:C4 for the cycling keys), and one undone edit. */
function model(range = false): CellsModel {
  const m = createCellsModel();
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
      [null, null, null, null],
      [17, 18, 19, 20],
    ],
  });
  m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 1 }, cells: [['x']] });
  m.undo();
  const zone = range
    ? { top: 2, left: 1, bottom: 3, right: 2 }
    : { top: 2, left: 1, bottom: 2, right: 1 };
  m.select({ sheet: 's1', zones: [zone], anchor: { row: 2, col: 1 }, active: { row: 2, col: 1 } });
  return m;
}

function mount(m: CellsModel, keymap?: Record<string, string | null>): HTMLElement {
  const div = document.createElement('div');
  document.body.append(div);
  const root = createRoot(div);
  roots.push(root);
  act(() => root.render(<Spreadsheet model={m} keymap={keymap} />));
  return div.querySelector<HTMLElement>('[role="grid"]')!;
}

function press(grid: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    grid.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

/** What a key can change: the selection, the editor, the values of the block. */
function state(m: CellsModel) {
  const values: unknown[] = [];
  for (let r = 0; r < 6; r += 1) for (let c = 0; c < 4; c += 1) values.push(m.value('s1', r, c));
  return { selection: m.selection, edit: m.edit, values };
}

/** Each moved key, with the command it reaches. */
const MOVED: readonly (readonly [string, KeyboardEventInit, boolean?])[] = [
  ['cells.moveUp', { key: 'ArrowUp' }],
  ['cells.moveDown', { key: 'ArrowDown' }],
  ['cells.moveLeft', { key: 'ArrowLeft' }],
  ['cells.moveRight', { key: 'ArrowRight' }],
  ['cells.jumpUp', { key: 'ArrowUp', ctrlKey: true }],
  ['cells.jumpDown', { key: 'ArrowDown', ctrlKey: true }],
  ['cells.jumpLeft', { key: 'ArrowLeft', ctrlKey: true }],
  ['cells.jumpRight', { key: 'ArrowRight', ctrlKey: true }],
  ['cells.extendUp', { key: 'ArrowUp', shiftKey: true }],
  ['cells.extendDown', { key: 'ArrowDown', shiftKey: true }],
  ['cells.extendLeft', { key: 'ArrowLeft', shiftKey: true }],
  ['cells.extendRight', { key: 'ArrowRight', shiftKey: true }],
  ['cells.extendJumpUp', { key: 'ArrowUp', ctrlKey: true, shiftKey: true }],
  ['cells.extendJumpDown', { key: 'ArrowDown', ctrlKey: true, shiftKey: true }],
  ['cells.extendJumpLeft', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true }],
  ['cells.extendJumpRight', { key: 'ArrowRight', ctrlKey: true, shiftKey: true }],
  ['cells.nextRight', { key: 'Tab' }, true],
  ['cells.nextLeft', { key: 'Tab', shiftKey: true }, true],
  ['cells.nextDown', { key: 'Enter' }, true],
  ['cells.nextUp', { key: 'Enter', shiftKey: true }, true],
  ['cells.goToRowStart', { key: 'Home' }],
  ['cells.extendToRowStart', { key: 'Home', shiftKey: true }],
  ['cells.goToStart', { key: 'Home', ctrlKey: true }],
  ['cells.extendToStart', { key: 'Home', ctrlKey: true, shiftKey: true }],
  ['cells.goToEnd', { key: 'End', ctrlKey: true }],
  ['cells.extendToEnd', { key: 'End', ctrlKey: true, shiftKey: true }],
  ['cells.pageDown', { key: 'PageDown' }],
  ['cells.pageUp', { key: 'PageUp' }],
  ['cells.extendPageDown', { key: 'PageDown', shiftKey: true }],
  ['cells.extendPageUp', { key: 'PageUp', shiftKey: true }],
  ['cells.selectColumns', { key: ' ', ctrlKey: true }],
  ['cells.selectRows', { key: ' ', shiftKey: true }],
  ['cells.selectAll', { key: 'a', ctrlKey: true }],
  ['cells.editCell', { key: 'F2' }],
  ['cells.clearAndEdit', { key: 'Backspace' }],
  ['cells.clearContents', { key: 'Delete' }],
  ['cells.redo', { key: 'z', ctrlKey: true, shiftKey: true }],
];

describe('the keys as Reactor commands', () => {
  it('names every moved command in the Cells category, with its keys', () => {
    const all = [...EDITING_COMMANDS, ...NAVIGATION_COMMANDS];
    for (const [id] of MOVED) {
      const c = all.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(c!.category).toBe('Cells');
      expect([c!.keybinding, ...(c!.gridKeybindings ?? [])].filter(Boolean).length).toBeGreaterThan(
        0,
      );
    }
  });

  for (const [id, init, range] of MOVED) {
    it(`${init.ctrlKey ? 'Mod+' : ''}${init.shiftKey ? 'Shift+' : ''}${init.key === ' ' ? 'Space' : init.key} runs ${id}, which does what the key does`, async () => {
      const pressed = model(range);
      const ran = model(range);
      const grid = mount(pressed);
      const twin = mount(ran);
      const spy = vi.spyOn(pressed.reactor, 'executeCommand');
      press(grid, init);
      expect(spy).toHaveBeenCalledWith(id, expect.objectContaining({ model: pressed }));
      // Run by its id alone, as a palette runs it: the grid that last had the focus.
      act(() => twin.focus());
      await act(async () => {
        await ran.reactor.executeCommand(id);
      });
      expect(state(ran)).toEqual(state(pressed));
      // And the key did something.
      expect(state(pressed)).not.toEqual(state(model(range)));
    });
  }

  it('Shift+F10 and the ContextMenu key run cells.openContextMenu, which opens the grid’s menu', async () => {
    const m = model();
    const grid = mount(m);
    const spy = vi.spyOn(m.reactor, 'executeCommand').mockResolvedValue(undefined);
    press(grid, { key: 'F10', shiftKey: true });
    press(grid, { key: 'ContextMenu' });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'cells.openContextMenu',
      'cells.openContextMenu',
    ]);
    spy.mockRestore();
    const openMenu = vi.fn();
    const access: CellsGridAccess = { sheet: 's1', pageRows: 10, scrollTo: () => {}, openMenu };
    await m.reactor.executeCommand('cells.openContextMenu', { model: m, grid: access });
    expect(openMenu).toHaveBeenCalledTimes(1);
  });

  it("a host's keymap rebinds a moved key, and unbinds one with null", () => {
    const m = model();
    const grid = mount(m, { 'cells.editCell': 'Mod+E', 'cells.moveDown': null });
    press(grid, { key: 'ArrowDown' });
    expect(m.selection.active).toEqual({ row: 2, col: 1 });
    press(grid, { key: 'F2' });
    expect(m.edit).toBeNull();
    press(grid, { key: 'e', ctrlKey: true });
    expect(m.edit).not.toBeNull();
  });

  it('a command run with no argument and no grid says so', async () => {
    await expect(
      createCellsModel().reactor.executeCommand('cells.pageDown', undefined),
    ).rejects.toThrow(/grid/);
  });
});
