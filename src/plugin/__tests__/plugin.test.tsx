/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

import { buildReactorFromPlugins, contribution, definePlugin } from '@datalayer/reactor';
import { registerReactor } from '@datalayer/reactor/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CellsFunctions, fromRows } from '../../core/index.js';
import {
  CELLS_COMMANDS,
  cellsShellPlugins,
  getWorkbooksState,
  resetWorkbooks,
  WorkbookCatalog,
  WorkbookList,
  workbookModel,
  WorkbookView,
} from '../index.js';

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
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
  globalThis.requestAnimationFrame = (f: FrameRequestCallback) =>
    setTimeout(() => f(0), 0) as unknown as number;
});

/** A plugin installed in the shell, as a third party writes one: a function, and a workbook. */
const Twice = definePlugin({
  name: '@acme/twice',
  contributes: [
    contribution(CellsFunctions, {
      name: 'TWICE',
      args: [{ name: 'x', type: 'scalar' }],
      returns: 'number',
      category: 'math',
      compute: ([x]) => (x as number) * 2,
      description: 'Twice a number.',
      examples: ['=TWICE(2) → 4'],
    }),
    contribution(
      WorkbookCatalog,
      { id: 'acme-prices', title: 'Prices', data: fromRows([['Apples', 3]]) },
      { id: 'acme-prices' },
    ),
  ],
});

function shell() {
  const platform = buildReactorFromPlugins([...cellsShellPlugins(), Twice]);
  platform.start();
  registerReactor(platform);
  return platform;
}

let root: Root | undefined;
beforeEach(() => resetWorkbooks());
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode): HTMLDivElement {
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(node));
  return div;
}

describe('the Reactor shell plugin', () => {
  it('creates, opens, renames and deletes workbooks by its commands', async () => {
    const platform = shell();
    const created = (await platform.executeCommand(CELLS_COMMANDS.create, { title: 'Budget' })) as {
      id: string;
    };
    expect(getWorkbooksState()).toEqual({
      workbooks: [{ id: created.id, title: 'Budget' }],
      open: created.id,
    });
    await platform.executeCommand(CELLS_COMMANDS.rename, { id: created.id, title: 'Budget 2027' });
    await platform.executeCommand(CELLS_COMMANDS.list);
    expect(getWorkbooksState().open).toBeNull();
    await platform.executeCommand(CELLS_COMMANDS.open, { id: created.id });
    expect(getWorkbooksState().workbooks[0].title).toBe('Budget 2027');
    await expect(platform.executeCommand(CELLS_COMMANDS.open, { id: 'nope' })).rejects.toThrow(
      /no workbook 'nope'/,
    );
    await platform.executeCommand(CELLS_COMMANDS.remove, { id: created.id });
    expect(getWorkbooksState()).toEqual({ workbooks: [], open: null });
  });

  it('the grids it opens share the shell platform: a plugin installed in the shell adds a function to each', async () => {
    const platform = shell();
    const a = (await platform.executeCommand(CELLS_COMMANDS.create)) as { id: string };
    const b = (await platform.executeCommand(CELLS_COMMANDS.create)) as { id: string };
    for (const { id } of [a, b]) {
      const model = workbookModel(id, platform);
      expect(model.reactor).toBe(platform);
      model.dispatch({
        type: 'SET_CELLS',
        sheet: 's1',
        at: { row: 0, col: 0 },
        cells: [[{ formula: 'TWICE(21)' }]],
      });
      expect(model.value('s1', 0, 0)).toBe(42);
    }
    expect(workbookModel(a.id, platform)).toBe(workbookModel(a.id, platform));
  });

  it('lists the workbooks plugins contribute, and shows the open one with its chrome', async () => {
    shell();
    const div = mount(
      <>
        <WorkbookList />
        <WorkbookView />
      </>,
    );
    expect(div.querySelector('nav[aria-label="Workbooks"]')?.textContent).toContain('Prices');
    expect(div.textContent).toContain('No workbook is open.');
    const prices = [...div.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Prices'),
    )!;
    act(() =>
      ((prices.querySelector('[role="menuitem"], button, li') as HTMLElement) ?? prices).click(),
    );
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
    expect(getWorkbooksState().open).toBe('acme-prices');
    expect(div.querySelector('[role="grid"]')?.getAttribute('aria-label')).toBe('Prices');
    expect(div.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(div.querySelector('[role="tablist"]')?.textContent).toContain('Sheet1');
  });
});
