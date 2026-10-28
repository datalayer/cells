/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The context menu is Primer's Overlay and ActionList: opened by a right
 * click or the ContextMenu key, hover focuses an item (Primer's hover
 * state), a click or Enter runs its command, arrows move, Escape closes and
 * returns focus to the grid.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCellsModel, type Transaction } from '../../core/index.js';
import { Spreadsheet } from '../Spreadsheet.js';

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

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
});

async function mount() {
  const model = createCellsModel({ limits: { rows: 100, cols: 20 } });
  model.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [['b'], ['a'], ['c']],
  });
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  await act(async () => root!.render(<Spreadsheet model={model} theme="auto" />));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const grid = div.querySelector('[role="grid"]') as HTMLElement;
  return { model, div, grid };
}

const menu = () => document.querySelector('[role="menu"][data-cells-menu]') as HTMLElement | null;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

async function openByRightClick(grid: HTMLElement) {
  await act(async () => {
    grid.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 60 }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('the context menu', () => {
  it('is a Primer Overlay in the grid’s own portal root, with an ActionList of menu items', async () => {
    const { div, grid } = await mount();
    expect(menu()).toBeNull();
    await openByRightClick(grid);
    const m = menu();
    expect(m).not.toBeNull();
    expect(div.contains(m)).toBe(true); // portalled into the grid root, not document.body
    expect(grid.contains(m)).toBe(true);
    const list = m!.querySelector('ul');
    expect(list?.className).toMatch(/ActionList/);
    expect(items().length).toBeGreaterThan(3);
    expect(items().map((i) => i.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Sort A to Z/)]),
    );
    expect(
      m!.querySelectorAll('[role="separator"], li[aria-hidden="true"], hr').length,
    ).toBeGreaterThan(0);
    // The first item has the focus; a keybinding shows as a trailing visual.
    expect(items()).toContain(document.activeElement);
    expect(items().some((i) => i.getAttribute('aria-keyshortcuts'))).toBe(true);
  });

  it('hover focuses the item (Primer’s hover state), a click runs its command', async () => {
    const { model, grid } = await mount();
    // A1:A3 selected, the menu opened inside it: the sort applies to the selection.
    model.select({
      sheet: 's1',
      zones: [{ top: 0, left: 0, bottom: 2, right: 0 }],
      anchor: { row: 0, col: 0 },
      active: { row: 0, col: 0 },
    });
    await openByRightClick(grid);
    const sort = items().find((i) => /Sort A to Z/.test(i.textContent ?? ''))!;
    await act(async () => {
      sort.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.activeElement).toBe(sort);
    expect(sort.closest('li')?.className).toMatch(/ActionListItem/);
    const seen: Transaction[] = [];
    model.subscribe((tx) => seen.push(tx));
    await act(async () => {
      sort.click();
    });
    expect(seen.map((t) => t.label)).toContain('SORT');
    expect(model.toRows({ top: 0, left: 0, bottom: 2, right: 0 })).toEqual([['a'], ['b'], ['c']]);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(grid);
  });

  it('opens from the keyboard, arrows and Home/End move, Escape closes and returns focus to the grid', async () => {
    const { grid } = await mount();
    grid.focus();
    await act(async () => {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(menu()).not.toBeNull();
    const all = items();
    expect(document.activeElement).toBe(all[0]);
    await act(async () => {
      all[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(all[1]);
    await act(async () => {
      all[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(all[all.length - 1]);
    await act(async () => {
      all[all.length - 1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(all[0]);
    await act(async () => {
      all[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(grid);
  });
});
