/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The examples' *A Reactor plugin* page (C7-01): a grid on the core plugin
 * and `@acme/everything` alone, the points table naming what the plugin
 * contributes to each, the toolbar with the plugin's commands, the gate's
 * refusal, and the duplicate refused at start with its sentence.
 */

import { act, version as reactVersion } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BaseStyles, ThemeProvider } from '@primer/react';
import Plugin from '../../../examples/src/examples/08-plugin.js';

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

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe(`the plugin example page (React ${reactVersion})`, () => {
  it('lists every point with the plugin’s contributions, runs its commands, and refuses the duplicate', async () => {
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    act(() => {
      root!.render(
        <ThemeProvider>
          <BaseStyles>
            <Plugin />
          </BaseStyles>
        </ThemeProvider>,
      );
    });
    await tick();
    const rows = [...div.querySelectorAll('table[aria-label="Contribution points"] tbody tr')];
    expect(rows).toHaveLength(18);
    const empty = rows
      .filter((r) => r.querySelectorAll('td')[1].textContent === 'none')
      .map((r) => r.querySelector('code')!.textContent);
    expect(empty).toEqual([]);
    expect(
      rows.find((r) => r.textContent!.includes('datalayer.cells.function'))!.textContent,
    ).toContain('SHOUT, ECHO');
    // The toolbar: the plugin's two commands, named, and nothing of the built-in chrome.
    const toolbar = div.querySelector('[role="toolbar"]')!;
    expect(
      [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    ).toEqual(['UPPERCASE the selection (Ctrl+Shift+U)', 'Note: check this']);
    const names = () => [...div.querySelectorAll('[role="gridcell"]')].map((c) => c.textContent);
    expect(names()).toContain('Shouted: LOUD');
    expect(names()).toContain('HELLO, formula: =SHOUT(A2)');
    expect(names()).toContain('#NAME?, formula: =SUM(B2:B3), unknown name');
    // The data source's first page arrives for the mirror (the primes, after the source's 50 ms):
    // waited for, not timed, since a loaded runner takes longer.
    for (let i = 0; i < 100 && !names().includes('2'); i += 1)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    expect(names()).toContain('2');
    const button = (name: string) =>
      [...div.querySelectorAll('button')].find((b) => b.textContent === name)!;
    act(() => button('UPPERCASE the selection').click());
    expect(names()).toContain('HELLO');
    act(() => button('Write into row 1').click());
    expect(div.querySelector('[data-message]')!.textContent).toBe(
      "Row 1 is Acme's header row: locked by @acme/everything.",
    );
    act(() => button('Start a grid with a duplicate plugin').click());
    expect(div.querySelector('[data-duplicate]')!.textContent).toBe(
      "The function 'SHOUT' is contributed twice to datalayer.cells.function: by @acme/everything " +
        "(id 'SHOUT') and by @acme/twice (id 'SHOUT'). Disable one of the two plugins, or rename one function.",
    );
    act(() => button('Disable it').click());
    expect(names()).not.toContain('Shouted: LOUD');
    expect(names()).toContain('#NAME?, formula: =SHOUT(A2), unknown name');
    expect([...toolbar.querySelectorAll('button')]).toHaveLength(0);
  });
});
