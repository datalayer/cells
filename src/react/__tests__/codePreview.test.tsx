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
 * on the selected cell and Escape closes it. Its strip drags it: open while
 * dragged, pinned where dropped (the code cell's frame with its offset, one
 * undo step), and *Unpin* clears it. A pinned cell opens no preview.
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

  it('its strip drags it, open while dragged; the drop pins it there (the frame and its offset, one undo step), and Unpin clears it', async () => {
    const { m, div, grid } = await mount();
    vi.useFakeTimers();
    move(grid, 1, 1);
    act(() => {
      vi.advanceTimersByTime(CODE_HOVER_MS + 50);
    });
    const box = preview(div)!;
    const handle = div.querySelector<HTMLElement>('[data-cells-code-preview-handle]')!;
    expect(handle.textContent).toBe('Output of B2');
    const at = () => ({ left: parseFloat(box.style.left), top: parseFloat(box.style.top) });
    const start = at();
    const pointer = (el: HTMLElement, type: string, x: number, y: number, init = {}) =>
      act(() => {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: x,
            clientY: y,
            ...init,
          }),
        );
      });
    pointer(handle, 'pointerover', 300, 100);
    pointer(handle, 'pointerdown', 300, 100);
    pointer(handle, 'pointermove', 500, 300);
    // The pointer leaves it mid-drag: it stays.
    pointer(handle, 'pointerout', 700, 380, { relatedTarget: grid });
    expect(preview(div)).toBe(box);
    expect(at()).toEqual({ left: start.left + 200, top: start.top + 200 });
    const revision = m.revision;
    pointer(handle, 'pointerup', 520, 320);
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    // Pinned: one step writes the frame, the preview gives way to it, at the drop.
    expect(m.revision).toBe(revision + 1);
    const frame = m.code('s1', 1, 1)!.frame!;
    const s = m.sheet('s1');
    const h = headerSizes(LIMITS.rows, true);
    expect(frame.dx).toBe(start.left + 220 - (h.width + s.cols.offsetOf(2)));
    expect(frame.dy).toBe(start.top + 220 - (h.height + s.rows.offsetOf(1)));
    expect(frame.width).toBeGreaterThan(0);
    expect(preview(div)).toBeNull();
    const pinned = div.querySelector<HTMLElement>('[role="region"][data-cells-code-output="B2"]')!;
    expect(parseFloat(pinned.style.left)).toBe(start.left + 220 - h.width);
    // Unpin: no frame again, one step, and the hover shows the outputs.
    act(() => pinned.querySelector<HTMLElement>('[data-cells-code-unpin]')!.click());
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(m.code('s1', 1, 1)!.frame).toBeNull();
    expect(m.revision).toBe(revision + 2);
    expect(div.querySelector('[data-cells-code-output="B2"]')).toBeNull();
    move(grid, 3, 1);
    move(grid, 1, 1);
    act(() => {
      vi.advanceTimersByTime(CODE_HOVER_MS + 50);
    });
    expect(preview(div)).not.toBeNull();
  });

  it('a cell whose outputs are pinned in a frame opens no preview: neither a hover nor Alt+Down', async () => {
    const { m, div, grid } = await mount();
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 1,
      col: 1,
      code: { ...m.code('s1', 1, 1)!, frame: { width: 200, height: 100, dx: 10, dy: 10 } },
    });
    await tick();
    expect(div.querySelector('[data-cells-code-output="B2"]')).not.toBeNull();
    vi.useFakeTimers();
    move(grid, 1, 1);
    act(() => {
      vi.advanceTimersByTime(CODE_HOVER_MS + 50);
    });
    expect(preview(div)).toBeNull();
    vi.useRealTimers();
    act(() =>
      m.select({
        sheet: 's1',
        zones: [{ top: 1, left: 1, bottom: 1, right: 1 }],
        anchor: { row: 1, col: 1 },
        active: { row: 1, col: 1 },
      }),
    );
    await expect(m.reactor.executeCommand('cells.code.preview')).rejects.toThrow(
      'Its output is pinned beside the cell',
    );
    expect(preview(div)).toBeNull();
  });
});
