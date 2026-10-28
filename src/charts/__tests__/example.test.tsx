/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * C10-10: the charts example page mounts and draws its four figures from the
 * chart points, with `echarts/core` mocked (jsdom draws nothing).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const setOption = vi.fn();
const instances = new Map<Element, unknown>();
vi.mock('echarts/core', () => ({
  use: () => undefined,
  init: (dom: Element) => {
    const instance = {
      setOption,
      resize: () => undefined,
      showLoading: () => undefined,
      hideLoading: () => undefined,
      dispose: () => instances.delete(dom),
      getOption: () => ({}),
      on: (event: string, cb: () => void) => {
        if (event === 'finished') cb();
      },
      off: () => undefined,
      isDisposed: () => false,
      getDom: () => dom,
    };
    instances.set(dom, instance);
    return instance;
  },
  getInstanceByDom: (dom: Element) => instances.get(dom),
  dispose: (dom: Element) => instances.delete(dom),
  registerTheme: () => undefined,
}));

import Charts, { WORKBOOK } from '../../../examples/src/examples/11-charts.js';
import { validateWorkbook, DEFAULT_LIMITS } from '../../core/index.js';

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
      width: 1400,
      height: 620,
      right: 1400,
      bottom: 620,
      toJSON: () => ({}),
    } as DOMRect;
  };
  globalThis.requestAnimationFrame = (f: FrameRequestCallback) =>
    setTimeout(() => f(0), 0) as unknown as number;
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as never;
});

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
});

describe('the charts example', () => {
  it('its workbook is valid', () => {
    expect(() => validateWorkbook(WORKBOOK, DEFAULT_LIMITS)).not.toThrow();
    expect(Object.keys(WORKBOOK.sheets[0].charts!)).toEqual(['column', 'line', 'pie', 'combo']);
  });

  it('mounts and draws the four figures from the chart points, once the lazy plugin loads', async () => {
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    await act(async () => root!.render(<Charts />));
    const figures = () => [...div.querySelectorAll('[role="figure"]')];
    // The theme comes from primer-addons on a promise, the viewport from the renderer's first
    // measure, and the plugin's module from its lazy load: wait for the four figures to be drawn.
    const settled = () =>
      figures().length === 4 && div.querySelectorAll('[data-cells-chart-placeholder]').length === 0;
    for (let i = 0; i < 100 && !settled(); i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
    expect(div.querySelector('[role="grid"]')).not.toBeNull();
    expect(figures().map((f) => f.getAttribute('data-cells-chart-type'))).toEqual([
      'column',
      'line',
      'pie',
      'combo',
    ]);
    expect(div.querySelectorAll('[data-cells-chart-placeholder]')).toHaveLength(0);
    expect(figures().map((f) => f.getAttribute('aria-label'))).toEqual([
      'Units sold, by region',
      'The year, month by month',
      'Online, share of the year',
      'Regions as columns, online as a line',
    ]);
    expect(setOption).toHaveBeenCalled();
    // The chrome beside the grid: the toolbar's Insert chart picker and the chart panel, which
    // edits the chart once one is selected.
    expect(div.querySelector('[data-cells-chart-picker]')).not.toBeNull();
    const panel = div.querySelector('[data-cells-chart-panel]')!;
    expect(panel.getAttribute('aria-label')).toBe('Chart panel');
    expect(panel.textContent).toContain('Select a chart');
    const column = div.querySelector('[data-cells-chart="column"]')!;
    await act(async () => {
      column.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect([...panel.querySelectorAll('label')].map((l) => l.textContent)).toEqual(
      expect.arrayContaining(['Type', 'Title', 'Legend', 'Data labels']),
    );
    const types = setOption.mock.calls.map(([o]) =>
      (o.series as { type: string }[]).map((s) => s.type).join('+'),
    );
    expect(new Set(types)).toEqual(
      new Set(['bar+bar+bar', 'line+line+line', 'pie', 'bar+bar+line']),
    );
  });
});
