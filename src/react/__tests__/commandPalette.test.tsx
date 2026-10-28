/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The command palette page: it mounts with `@datalayer/reactor-commands`,
 * lists the Cells commands, and the palette, opened with its own shortcut,
 * offers `cells.hideColumns` with its keybinding and runs it on the grid.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatKeybinding } from '@datalayer/reactor';
import { PALETTE_KEYBINDING } from '@datalayer/reactor-commands';
import CommandPaletteExample, {
  paletteModel,
} from '../../../examples/src/examples/15-command-palette.js';

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

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe('the command palette page', () => {
  it('mounts with the palette plugin and lists the Cells commands with their keys', async () => {
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    act(() => root!.render(<CommandPaletteExample />));
    await tick();
    expect(div.querySelector('[data-palette-shortcut]')!.textContent).toBe(
      formatKeybinding(PALETTE_KEYBINDING),
    );
    const row = div.querySelector('tr[data-command="cells.hideColumns"]')!;
    expect(row.textContent).toContain('Hide columns');
    expect(row.textContent).toContain('Ctrl+Alt+0');
    expect(div.querySelector('tr[data-command="cells.moveDown"]')!.textContent).toContain('↓');
  });

  it('opens on its shortcut, offers cells.hideColumns with its keybinding, and runs it on the grid', async () => {
    const div = document.createElement('div');
    document.body.append(div);
    root = createRoot(div);
    const model = paletteModel();
    act(() => root!.render(<CommandPaletteExample model={model} />));
    await tick();
    const grid = div.querySelector<HTMLElement>('[role="grid"]')!;
    act(() => grid.focus());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await tick();
    const dialog = document.querySelector('[role="dialog"][aria-label="Command palette"]')!;
    expect(dialog).not.toBeNull();
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'Hide columns');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const option = [...dialog.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent!.includes('Hide columns'),
    )!;
    expect(option).toBeDefined();
    expect(option.querySelector('kbd')!.textContent).toBe('Ctrl+Alt+0');
    // Run from the palette: no argument, the grid that has the focus.
    await act(async () => {
      (option as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector('[role="dialog"][aria-label="Command palette"]')).toBeNull();
    // A1 was active: column A is hidden.
    expect(model.sheet('s1').cols.isHidden(0)).toBe(true);
  });
});
