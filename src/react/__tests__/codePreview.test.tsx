/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The output preview (C11-05): hovering a code cell with outputs for 300 ms
 * opens its outputs in Primer's Overlay at the cell, drawn by the
 * contributed renderer; moving to another cell closes it; Alt+Down opens it
 * on the selected cell and Escape closes it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { contribution, definePlugin } from '@datalayer/reactor';
import {
  CellsCodeRenderer,
  codeCell,
  type CodeOutputRendererProps,
  createCellsModel,
  Spreadsheet,
} from '../../index.js';
import { headerSizes } from '../../render/viewport.js';
import { CODE_HOVER_MS } from '../Spreadsheet.js';

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
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const LIMITS = { rows: 100, cols: 20 };
const stream = (text: string) => ({ output_type: 'stream' as const, name: 'stdout', text });

function Probe({ outputs, cell }: CodeOutputRendererProps) {
  return <div data-test-preview={cell}>{String((outputs[0] as { text?: string }).text)}</div>;
}

const RendererPlugin = definePlugin({
  name: 'preview-probe',
  contributes: [contribution(CellsCodeRenderer, { id: 'probe', output: Probe }, { id: 'probe' })],
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount() {
  const m = createCellsModel({ limits: LIMITS, plugins: [RendererPlugin] });
  m.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row: 1,
    col: 1,
    code: codeCell('print(1)', { outputs: [stream('hello')], frame: null }),
  });
  m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 3, col: 1, code: codeCell('x') });
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(<Spreadsheet model={m} />));
  await tick();
  const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
  return { m, div, grid };
}

function middleOf(row: number, col: number) {
  const h = headerSizes(LIMITS.rows, true);
  return { clientX: h.width + col * 100 + 50, clientY: h.height + row * 21 + 10 };
}

const move = (grid: HTMLElement, row: number, col: number) =>
  act(() => {
    // jsdom has no PointerEvent; React's onPointerMove takes a `pointermove` MouseEvent.
    grid.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...middleOf(row, col) }));
  });

const preview = (div: HTMLElement) => div.querySelector<HTMLElement>('[data-cells-code-preview]');

describe('the output preview', () => {
  it('opens after the pointer rests on a code cell with outputs, drawn by the renderer, and closes on another cell', async () => {
    const { div, grid } = await mount();
    vi.useFakeTimers();
    move(grid, 1, 1);
    expect(preview(div)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(CODE_HOVER_MS - 50);
    });
    expect(preview(div)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(preview(div)).not.toBeNull();
    expect(preview(div)!.closest('[role="region"]')!.getAttribute('aria-label')).toBe(
      'Output of B2',
    );
    expect(div.querySelector('[data-test-preview="B2"]')!.textContent).toBe('hello');
    // Resting on a cell with no outputs opens nothing; leaving B2 closed its preview.
    move(grid, 3, 1);
    expect(preview(div)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(CODE_HOVER_MS + 50);
    });
    expect(preview(div)).toBeNull();
  });

  it('Alt+Down opens it on the selected cell, Escape closes it; a cell with no outputs refuses', async () => {
    const { m, div, grid } = await mount();
    act(() => grid.focus());
    act(() =>
      m.select({
        sheet: 's1',
        zones: [{ top: 1, left: 1, bottom: 1, right: 1 }],
        anchor: { row: 1, col: 1 },
        active: { row: 1, col: 1 },
      }),
    );
    act(() => {
      grid.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await tick();
    expect(preview(div)).not.toBeNull();
    // Alt+Down did not move the selection.
    expect(m.selection.active).toEqual({ row: 1, col: 1 });
    act(() => {
      preview(div)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await tick();
    expect(preview(div)).toBeNull();
    act(() =>
      m.select({
        sheet: 's1',
        zones: [{ top: 3, left: 1, bottom: 3, right: 1 }],
        anchor: { row: 3, col: 1 },
        active: { row: 3, col: 1 },
      }),
    );
    await expect(m.reactor.executeCommand('cells.code.preview')).rejects.toThrow(
      'This cell shows no output.',
    );
  });
});
