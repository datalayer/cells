/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * C10-04 (jsdom): the chart panel edits the selected chart (type, variant,
 * title, a series' ranges, legend, axes, labels), each as an UPDATE_CHART,
 * and the toolbar's picker inserts a chart of the chosen type from the
 * selection.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CellsProvider, type CellsModel, createCellsModel, type Transaction } from '../../index.js';
import { ChartPanel, Toolbar } from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = '';
});

function render(model: CellsModel, node: React.ReactNode): HTMLElement {
  const div = document.createElement('div');
  document.body.append(div);
  const root = createRoot(div);
  act(() => root.render(<CellsProvider model={model}>{node}</CellsProvider>));
  cleanup = () => act(() => root.unmount());
  return div;
}

function model() {
  const m = createCellsModel({ limits: { rows: 100, cols: 20 } });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: [
      ['Month', 'North', 'South'],
      ['Jan', 10, 7],
      ['Feb', 12, 9],
      ['Mar', 15, 11],
    ],
  });
  m.select({
    sheet: 's1',
    zones: [{ top: 0, left: 0, bottom: 3, right: 2 }],
    anchor: { row: 0, col: 0 },
    active: { row: 0, col: 0 },
  });
  return m;
}

const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
function type(input: HTMLInputElement, text: string) {
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}
function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    setSelect.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const byLabel = (div: HTMLElement, label: string) =>
  [...div.querySelectorAll('label')].find((l) => l.textContent === label)!;
const control = (div: HTMLElement, label: string) =>
  document.getElementById(byLabel(div, label).getAttribute('for')!) as HTMLInputElement &
    HTMLSelectElement;

describe('the chart panel', () => {
  it('says to select a chart; then edits the selected one as UPDATE_CHARTs, refusals told', async () => {
    const m = model();
    const errors: string[] = [];
    const div = render(m, <ChartPanel onError={(e) => errors.push(e)} />);
    expect(div.textContent).toContain('Select a chart');
    await act(async () => {
      await m.reactor.executeCommand('cells.chart.insert', { model: m });
    });
    expect(m.selectedChart).toBe('chart1');
    const seen: Transaction[] = [];
    m.subscribe((tx) => seen.push(tx));
    expect(div.querySelector('[role="region"]')!.getAttribute('aria-label')).toBe('Chart chart1');
    choose(control(div, 'Type'), 'line');
    choose(control(div, 'Variant'), 'smooth');
    type(control(div, 'Title'), 'Sales');
    choose(control(div, 'Legend'), 'right');
    type(control(div, 'Y axis title'), 'Units');
    type(control(div, 'Y axis maximum'), '20');
    act(() => control(div, 'Data labels').click());
    const spec = () => m.sheet('s1').charts.get('chart1')!;
    expect(spec()).toMatchObject({
      type: 'line',
      variant: 'smooth',
      title: 'Sales',
      legend: 'right',
      axes: { y: { title: 'Units', max: 20 } },
      labels: true,
    });
    expect(seen.map((t) => t.commands[0].type)).toEqual(Array(7).fill('UPDATE_CHART'));
    // A series' ranges: the second series' values, then a range that is not one.
    type(control(div, 'Values'), 'Sheet1!$B$2:$B$4');
    expect(spec().data.series[0].values).toBe('Sheet1!$B$2:$B$4');
    type(control(div, 'Categories'), 'nonsense');
    expect(errors.at(-1)).toMatch(/categories: not a range/);
    expect(spec().data.series[0].categories).toBe('Sheet1!$A$2:$A$4');
    // Add and remove a series.
    act(() =>
      [...div.querySelectorAll('button')].find((b) => b.textContent === 'Add series')!.click(),
    );
    expect(spec().data.series).toHaveLength(3);
    act(() =>
      [...div.querySelectorAll('button')].find((b) => b.textContent === 'Remove series 3')!.click(),
    );
    expect(spec().data.series).toHaveLength(2);
    expect(div.querySelector('[role="region"]')!.getAttribute('aria-label')).toBe('Chart Sales');
    m.undo();
    expect(spec().data.series).toHaveLength(3);
  });

  it('the toolbar’s picker lists the types and inserts the chosen one from the selection', async () => {
    const m = model();
    const div = render(m, <Toolbar />);
    const button = div.querySelector('[data-cells-chart-picker]') as HTMLButtonElement;
    expect(button.textContent).toBe('Insert chart');
    act(() => button.click());
    const items = [...document.querySelectorAll('[data-chart-type]')];
    expect(items.map((i) => i.getAttribute('data-chart-type'))).toEqual([
      'bar',
      'column',
      'line',
      'area',
      'pie',
      'scatter',
      'combo',
    ]);
    await act(async () => {
      (items.find((i) => i.getAttribute('data-chart-type') === 'pie') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...m.sheet('s1').charts.values()].map((c) => c.type)).toEqual(['pie']);
    expect(m.selectedChart).toBe('chart1');
    expect(div.querySelector('[role="group"][aria-label="charts"]')).not.toBeNull();
    const without = render(m, <Toolbar charts={false} />);
    expect(without.querySelector('[data-cells-chart-picker]')).toBeNull();
  });
});
