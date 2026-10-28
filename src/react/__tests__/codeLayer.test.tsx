/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The output frames of code cells (C11-05) and *Open in editor* (C11-06),
 * in the grid: a frame beside its cell, named "Output of C4", drawn by the
 * contributed renderer (Acme's text one here) or the `text/plain` fallback;
 * no frame for a cell with no outputs or `frame: null`; at most 20 mounted;
 * *Go to output* focuses the frame and Escape returns to the grid. A drag of
 * a frame's strip moves it (its offset, one undo step); *Unpin* takes the
 * frame away (`frame: null`, one undo step). The editor
 * overlay is `codeEditor.test.tsx` (Primer's Overlay, out of the React 18 harness).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contribution, definePlugin } from '@datalayer/reactor';
import {
  CellsCodeRenderer,
  codeCell,
  type CodeOutputRendererProps,
  createCellsModel,
  Spreadsheet,
} from '../../index.js';
import { CODE_FRAMES_CAP, outputsText, placeFrame, safeOutputs } from '../CodeLayer.js';

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
});

const stream = (text: string) => ({ output_type: 'stream' as const, name: 'stdout', text });

function TextOutput({ outputs, cell }: CodeOutputRendererProps) {
  return <div data-test-output={cell}>{outputsText(outputs)}</div>;
}

const RendererPlugin = definePlugin({
  name: 'test-renderer',
  contributes: [
    contribution(CellsCodeRenderer, { id: 'test', output: TextOutput }, { id: 'test', order: 10 }),
  ],
});

function mount(plugins: readonly unknown[] = []) {
  const m = createCellsModel({ limits: { rows: 100, cols: 20 }, plugins: plugins as never });
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(<Spreadsheet model={m} />));
  return { m, div, grid: div.querySelector<HTMLElement>('[role="grid"]')! };
}

/** Let the grid take its first frame (the viewport arrives on the next tick). */
const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const press = (el: HTMLElement, init: KeyboardEventInit) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });

describe('the output frames of code cells', () => {
  it('places a frame beside its cell, within one viewport', () => {
    const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
    const sheet = m.sheet('s1');
    const pane = { name: 'main', x: 0, y: 0, width: 800, height: 400, originX: 0, originY: 0 };
    const p = placeFrame(sheet, 3, 2, { width: 300, height: 200 }, pane as never, 1);
    expect(p.x).toBe(sheet.cols.offsetOf(3));
    expect(p.y).toBe(sheet.rows.offsetOf(3));
    expect(p.near).toBe(true);
    const far = placeFrame(sheet, 90, 2, { width: 300, height: 200 }, pane as never, 1);
    expect(far.near).toBe(false);
    // Moved by its offset, scaled by the zoom.
    const moved = placeFrame(
      sheet,
      3,
      2,
      { width: 300, height: 200, dx: 40, dy: -10 },
      pane as never,
      2,
    );
    expect(moved.x).toBe((sheet.cols.offsetOf(3) + 40) * 2);
    expect(moved.y).toBe((sheet.rows.offsetOf(3) - 10) * 2);
  });

  it("a drag of a frame's strip moves it, live, then writes its offset as one undo step; Unpin takes it away, one undo step too", async () => {
    const { m, div } = mount([RendererPlugin]);
    await tick();
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 3,
      col: 2,
      code: codeCell('t', { outputs: [stream('table')], frame: { width: 300, height: 200 } }),
    });
    await tick();
    const frame = () => div.querySelector<HTMLElement>('[data-cells-code-output="C4"]');
    const strip = frame()!.querySelector<HTMLElement>('[data-cells-code-output-handle]')!;
    expect(strip.textContent).toContain('Output of C4');
    const left = parseFloat(frame()!.style.left);
    const top = parseFloat(frame()!.style.top);
    const pointer = (type: string, x: number, y: number) =>
      act(() => {
        strip.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
      });
    const revision = m.revision;
    pointer('pointerdown', 500, 100);
    pointer('pointermove', 530, 140);
    expect([parseFloat(frame()!.style.left), parseFloat(frame()!.style.top)]).toEqual([
      left + 30,
      top + 40,
    ]);
    expect(m.revision).toBe(revision);
    pointer('pointerup', 560, 80);
    expect(m.revision).toBe(revision + 1);
    expect(m.code('s1', 3, 2)!.frame).toEqual({ width: 300, height: 200, dx: 60, dy: -20 });
    expect([parseFloat(frame()!.style.left), parseFloat(frame()!.style.top)]).toEqual([
      left + 60,
      top - 20,
    ]);
    // A press with no move writes nothing.
    pointer('pointerdown', 10, 10);
    pointer('pointerup', 11, 10);
    expect(m.revision).toBe(revision + 1);
    m.undo();
    expect(m.code('s1', 3, 2)!.frame).toEqual({ width: 300, height: 200 });
    m.redo();
    await tick();
    act(() => frame()!.querySelector<HTMLElement>('[data-cells-code-unpin]')!.click());
    await tick();
    expect(m.code('s1', 3, 2)!.frame).toBeNull();
    expect(frame()).toBeNull();
    m.undo();
    await tick();
    expect(m.code('s1', 3, 2)!.frame).toEqual({ width: 300, height: 200, dx: 60, dy: -20 });
    expect(frame()).not.toBeNull();
  });

  it('shows a frame named after its cell, drawn by the contributed renderer, and none without outputs or with frame: null', async () => {
    const { m, div } = mount([RendererPlugin]);
    await tick();
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 3,
      col: 2,
      code: codeCell('print(1)', { outputs: [stream('hello\n')], result: null }),
    });
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 5, col: 2, code: codeCell('x') });
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 7,
      col: 2,
      code: codeCell('y', { outputs: [stream('hidden')], frame: null }),
    });
    await tick();
    const frames = [...div.querySelectorAll('[role="region"][data-cells-code-output]')];
    expect(frames.map((f) => f.getAttribute('aria-label'))).toEqual(['Output of C4']);
    expect(frames[0].querySelector('[data-test-output="C4"]')!.textContent).toBe('hello');
  });

  it('falls back to the text of the outputs with no renderer, and mounts at most 20 frames', async () => {
    const { m, div } = mount();
    await tick();
    m.transact('Many', () => {
      for (let r = 0; r < 25; r += 1)
        m.dispatch({
          type: 'SET_CODE',
          sheet: 's1',
          row: r,
          col: 1,
          code: codeCell('p', { outputs: [stream(`out ${r}`)] }),
        });
    });
    await tick();
    const frames = [...div.querySelectorAll('[data-cells-code-output]')];
    expect(frames).toHaveLength(25);
    const drawn = frames.filter((f) => f.querySelector('[data-cells-code-text]') !== null);
    expect(drawn).toHaveLength(CODE_FRAMES_CAP);
    expect(drawn[0].querySelector('[data-cells-code-text]')!.textContent).toBe('out 0');
  });

  it('Go to output focuses the frame, Escape returns to the grid; a cell with no frame refuses', async () => {
    const { m, div, grid } = mount();
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 1,
      col: 1,
      code: codeCell('p', { outputs: [stream('x')] }),
    });
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 2, col: 1, code: codeCell('q') });
    act(() => grid.focus());
    const at = (row: number) =>
      m.select({
        sheet: 's1',
        zones: [{ top: row, left: 1, bottom: row, right: 1 }],
        anchor: { row, col: 1 },
        active: { row, col: 1 },
      });
    act(() => at(1));
    await act(async () => {
      await m.reactor.executeCommand('cells.code.goToOutput');
    });
    const frame = div.querySelector<HTMLElement>('[data-cells-code-output="B2"]')!;
    expect(document.activeElement).toBe(frame);
    press(frame, { key: 'Escape' });
    expect(document.activeElement).toBe(grid);
    act(() => at(2));
    await expect(m.reactor.executeCommand('cells.code.goToOutput')).rejects.toThrow(
      'This cell shows no output.',
    );
  });

  it("shows an untrusted cell's text and images only, and everything once it ran here", async () => {
    const html = {
      output_type: 'display_data' as const,
      data: { 'text/html': '<b>bold</b>', 'text/plain': 'plain' },
      metadata: {},
    };
    const script = {
      output_type: 'display_data' as const,
      data: { 'application/javascript': 'alert(1)' },
      metadata: {},
    };
    expect(safeOutputs([html, script, stream('out')])).toEqual([
      { ...html, data: { 'text/plain': 'plain' } },
      {
        ...script,
        data: { 'text/plain': '[application/javascript: shown once the cell runs here]' },
      },
      stream('out'),
    ]);
    const seen: { trusted: boolean; mimes: string[] }[] = [];
    function Probe({ outputs, trusted }: CodeOutputRendererProps) {
      seen.push({ trusted, mimes: Object.keys((outputs[0] as unknown as { data: object }).data) });
      return null;
    }
    const plugin = definePlugin({
      name: 'probe',
      contributes: [
        contribution(CellsCodeRenderer, { id: 'probe', output: Probe }, { id: 'probe' }),
      ],
    });
    const { m, div } = mount([plugin]);
    await tick();
    // From a file: untrusted.
    m.replaceData({
      ...m.toJSON(),
      sheets: [
        {
          ...m.toJSON().sheets[0],
          code: { B2: codeCell('x', { outputs: [html], result: null }) },
        },
      ],
    });
    await tick();
    expect(div.querySelector('[data-cells-code-untrusted]')).not.toBeNull();
    expect(seen.at(-1)).toEqual({ trusted: false, mimes: ['text/plain'] });
    act(() => m.setCodeTrusted('s1', 1, 1));
    await tick();
    expect(div.querySelector('[data-cells-code-untrusted]')).toBeNull();
    expect(seen.at(-1)).toEqual({ trusted: true, mimes: ['text/html', 'text/plain'] });
  });
});
