/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The Code cells page: it mounts with its two code cells and D2's formula
 * over C2, and the kernel toggle switches the `datalayer.cells.kernel`
 * provider the grid runs on (the kernels mocked: neither Pyodide nor prod1
 * is reached here), keeping the choice in localStorage; the local server
 * only on a page served from this machine. C4 and C6 show on a hover (no
 * frame); a frame pinned or unpinned is kept per page across a reload.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CellsKernels,
  type CodeEditorRendererProps,
  type CodeRenderer,
  type KernelProvider,
} from '../../index.js';
import { headerSizes } from '../../render/viewport.js';
import CodeCells, {
  CODE_CELLS_KEY,
  codeCellsModel,
  KERNEL_TARGET_KEY,
  keepCodeCells,
  readCodeCells,
  readKernelTarget,
  targetAvailable,
} from '../../../examples/src/examples/13-code-cells.js';

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
  // Primer's SegmentedControl asks the media queries; jsdom has none.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
});

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

/** A kernel that answers every run with one stream line naming itself. */
const fake = (id: string): KernelProvider => ({
  id,
  label: id,
  connect: async () => ({
    execute: async () => ({
      outputs: [{ output_type: 'stream', name: 'stdout', text: `ran on ${id}` }],
    }),
  }),
});

/** A stand-in for jupyter-react's `Cell`, as the page's lazy renderer would mount it. */
const MOCK_RENDERER: CodeRenderer = {
  id: 'mock',
  output: () => null,
  editor: ({ row, col }: CodeEditorRendererProps) => (
    <textarea data-mock-cell={`${row},${col}`} defaultValue="" />
  ),
};

describe('the code cells page', () => {
  it('a double-click on C2 before any run opens the contributed editor, never the textarea', async () => {
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    act(() =>
      root!.render(
        <CodeCells
          providers={{ jupyter: fake('prod1'), local: fake('local'), browser: fake('lite') }}
          renderer={MOCK_RENDERER}
        />,
      ),
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    act(() => grid.focus());
    const h = headerSizes(1_048_576, true);
    // C2: column widths 100, 100, then C 120 (the page widens it); row 2 is 21 px down.
    const at = { clientX: h.width + 200 + 60, clientY: h.height + 21 + 10 };
    act(() => {
      grid.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, ...at }),
      );
    });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(div.querySelector('[data-mock-cell="1,2"]')).not.toBeNull();
    expect(div.querySelector('[data-cells-code-editor] textarea[aria-label="Source"]')).toBeNull();
  });

  it('holds the table, the two code cells and the formula over C2', () => {
    const m = codeCellsModel({
      jupyter: fake('prod1'),
      local: fake('local'),
      browser: fake('lite'),
    });
    expect(m.code('s1', 1, 2)?.source).toContain('cells["B2:B7"]');
    expect(m.code('s1', 3, 2)?.source).toContain('matplotlib');
    expect(m.code('s1', 3, 2)?.frame).toBeNull();
    expect(m.code('s1', 5, 2)?.frame).toBeNull();
    expect(m.content('s1', 1, 3)?.formula).toBe('C2*2');
    expect(m.cellTypeIds()).toContain('code');
  });

  it('prod1 by default; the toggle switches the kernel provider of the point and keeps the choice; Browser is off', async () => {
    window.localStorage.removeItem(KERNEL_TARGET_KEY);
    const fakes = { jupyter: fake('prod1'), local: fake('local'), browser: fake('lite') };
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    act(() => root!.render(<CodeCells providers={fakes} />));
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    const model = (await import('../../builtins/target.js')).currentCellsCommandTarget()!.model;
    const providers = () => model.reactor.getContributions(CellsKernels).map((c) => c.value.id);
    expect(providers()).toEqual(['prod1']);
    expect(div.querySelector('[data-kernel-hint]')!.textContent).toContain('prod1.datalayer.run');
    const button = (label: string) =>
      [...div.querySelectorAll('button')].find((b) => b.textContent === label)!;
    expect(
      [...div.querySelectorAll('[aria-labelledby="kernel-label"] button')].map(
        (b) => b.textContent,
      ),
    ).toEqual(['Jupyter (prod1)', 'Jupyter (local)', 'Browser']);
    act(() => button('Jupyter (local)').click());
    expect(providers()).toEqual(['local']);
    expect(div.querySelector('[data-kernel-hint]')!.textContent).toContain('localhost:8888');
    expect(window.localStorage.getItem(KERNEL_TARGET_KEY)).toBe('local');
    expect(readKernelTarget()).toBe('local');
    // A run goes to the kernel chosen.
    act(() => grid.focus());
    await act(async () => {
      await model.reactor.executeCommand('cells.code.run', { model });
    });
    expect(model.code('s1', 1, 2)?.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'ran on local' },
    ]);
    // Browser is shown, not chosen; a kept 'browser' reads as prod1.
    act(() => button('Browser').click());
    expect(providers()).toEqual(['local']);
    window.localStorage.setItem(KERNEL_TARGET_KEY, 'browser');
    expect(readKernelTarget()).toBe('jupyter');
  });

  it('the local server can be chosen only from this machine; a kept local on another site reads as prod1, Browser never', () => {
    expect(targetAvailable('local', 'localhost')).toBe(true);
    expect(targetAvailable('local', '127.0.0.1')).toBe(true);
    expect(targetAvailable('local', '::1')).toBe(true);
    expect(targetAvailable('local', 'cells.datalayer.tech')).toBe(false);
    expect(targetAvailable('jupyter', 'cells.datalayer.tech')).toBe(true);
    expect(targetAvailable('browser', 'localhost')).toBe(false);
    window.localStorage.setItem(KERNEL_TARGET_KEY, 'local');
    expect(readKernelTarget('cells.datalayer.tech')).toBe('jupyter');
    expect(readKernelTarget('127.0.0.1')).toBe('local');
  });

  it('keeps the code cells per page: a pin where dropped, an unpin and the last run come back on the next model', () => {
    window.localStorage.removeItem(CODE_CELLS_KEY);
    const fakes = { jupyter: fake('prod1'), local: fake('local'), browser: fake('lite') };
    const m = codeCellsModel(fakes, undefined, readCodeCells());
    const stop = keepCodeCells(m);
    const c6 = m.code('s1', 5, 2)!;
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 5,
      col: 2,
      code: { ...c6, frame: { width: 380, height: 180, dx: 40, dy: -24 } },
    });
    expect(JSON.parse(window.localStorage.getItem(CODE_CELLS_KEY)!)).toMatchObject({
      C6: { frame: { width: 380, height: 180, dx: 40, dy: -24 } },
    });
    // A run is kept too: its outputs and result show again on the next visit (untrusted until run there).
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 1,
      col: 2,
      code: {
        ...m.code('s1', 1, 2)!,
        result: 129,
        lastRun: '2026-10-28T16:00:00.000Z',
        executionCount: 1,
      },
    });
    stop();
    const again = codeCellsModel(fakes, undefined, readCodeCells());
    expect(again.code('s1', 5, 2)?.frame).toEqual({ width: 380, height: 180, dx: 40, dy: -24 });
    expect(again.code('s1', 3, 2)?.frame).toBeNull();
    expect(again.value('s1', 1, 2)).toBe(129);
    expect(again.value('s1', 1, 3)).toBe(258);
    expect(again.codeTrusted('s1', 1, 2)).toBe(false);
    const stop2 = keepCodeCells(again);
    again.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 5,
      col: 2,
      code: { ...again.code('s1', 5, 2)!, frame: null },
    });
    stop2();
    expect(codeCellsModel(fakes, undefined, readCodeCells()).code('s1', 5, 2)?.frame).toBeNull();
    // A bad entry is dropped, not loaded.
    window.localStorage.setItem(
      CODE_CELLS_KEY,
      JSON.stringify({ C6: { frame: { width: 'wide' } }, C4: { source: 'x' } }),
    );
    expect(readCodeCells()).toEqual({});
  });
});
