/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * The code editor of `./jupyter` (C11-06), with jupyter-react mocked (its
 * packages do not load in jsdom): the editor mounts while the kernel is
 * still connecting (the plain editor, editable, the outputs under it), the
 * `Cell` takes over once the kernel is connected, and a kernel that fails
 * to connect leaves the editor with the error said. The kernel indicator
 * says *not started*, then follows the connection's `statusChanged` from
 * idle to busy and back, and the model hears the state.
 */

import { Signal } from '@lumino/signaling';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contribution, definePlugin } from '@datalayer/reactor';
import { CellsKernels, codeCell, codeRunner, createCellsModel } from '../../core/index.js';

vi.mock('@datalayer/jupyter-react', () => ({
  Cell: ({ id, source }: { id: string; source: string }) => (
    <div data-mock-jupyter-cell={id}>{source}</div>
  ),
  Output: ({ outputs }: { outputs: { text?: string }[] }) => (
    <div data-mock-jupyter-output="">{outputs.map((o) => o.text).join('')}</div>
  ),
  cellsStore: { getState: () => ({ getSource: () => undefined }) },
  createLiteServiceManager: async () => ({}),
  jupyterReactStore: { getState: () => ({ serviceManager: {}, setServiceManager: () => {} }) },
  Kernel: class {},
  ServiceManagerLess: class {},
}));
vi.mock('@datalayer/jupyter-react/theme', () => ({
  JupyterReactTheme: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@datalayer/jupyter-react/kernel-indicator', async () => {
  const React = await import('react');
  return {
    KernelIndicator: ({
      kernel,
    }: {
      kernel: { status: string; statusChanged: Signal<unknown, string> } | null;
    }) => {
      const [status, setStatus] = React.useState(kernel?.status);
      React.useEffect(() => {
        if (kernel === null) return undefined;
        const on = (_c: unknown, s: string) => setStatus(s);
        kernel.statusChanged.connect(on);
        return () => {
          kernel.statusChanged.disconnect(on);
        };
      }, [kernel]);
      return (
        <span data-mock-indicator="">
          {status === undefined ? 'Unknown' : status[0].toUpperCase() + status.slice(1)}
        </span>
      );
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

/** A kernel connection as the indicator reads it: its status, and the signal that announces a change. */
function fakeConnection() {
  const connection = {
    id: 'k1',
    status: 'idle' as string,
    connectionStatus: 'connected',
    statusChanged: new Signal<unknown, string>({}),
    connectionStatusChanged: new Signal<unknown, string>({}),
  };
  const setStatus = (status: string) => {
    connection.status = status;
    connection.statusChanged.emit(status);
  };
  return { connection, setStatus };
}

/** A jupyter-react-shaped `CellsKernel` (its `kernel.connection` is what the indicator and the editor take). */
function fakeKernel(connection: ReturnType<typeof fakeConnection>['connection']) {
  return {
    kernel: { connection, ready: Promise.resolve() },
    execute: async () => ({ outputs: [] }),
    interrupt: async () => undefined,
    onStatus: (listener: (s: string) => void) => {
      const on = (_c: unknown, s: string) => listener(s);
      connection.statusChanged.connect(on);
      listener(connection.status);
      return () => {
        connection.statusChanged.disconnect(on);
      };
    },
  };
}

function modelWith(connect: () => Promise<unknown>) {
  const m = createCellsModel({
    plugins: [
      definePlugin({
        name: 'fake-kernel',
        contributes: [
          contribution(
            CellsKernels,
            { id: 'fake', label: 'Fake', connect: connect as never },
            { id: 'fake' },
          ),
        ],
      }),
    ],
  });
  m.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row: 1,
    col: 1,
    code: codeCell('1 + 1', { outputs: [{ output_type: 'stream', name: 'stdout', text: 'two' }] }),
  });
  return m;
}

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function mount(node: React.ReactNode) {
  const div = document.createElement('div');
  document.body.append(div);
  root = createRoot(div);
  act(() => root!.render(node));
  return div;
}

describe('the code editor of ./jupyter', () => {
  it('mounts while the kernel connects, then the Cell takes over, with the outputs under it', async () => {
    const { CodeCellEditor } = await import('../index.js');
    let resolve: (k: unknown) => void = () => undefined;
    const m = modelWith(() => new Promise((r) => (resolve = r)));
    const div = mount(<CodeCellEditor model={m} sheet="s1" row={1} col={1} onClose={() => {}} />);
    await tick();
    expect(div.querySelector('[data-cells-code-editor-kernel]')!.textContent).toBe(
      'Connecting the kernel…',
    );
    expect(div.querySelector('textarea[aria-label="Source"]')).not.toBeNull();
    expect(div.querySelector('[data-mock-jupyter-output]')!.textContent).toBe('two');
    expect(div.querySelector('[data-mock-jupyter-cell]')).toBeNull();
    const { connection } = fakeConnection();
    await act(async () => {
      resolve(fakeKernel(connection));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(div.querySelector('[data-mock-jupyter-cell]')!.textContent).toBe('1 + 1');
    expect(div.querySelector('textarea[aria-label="Source"]')).toBeNull();
    expect(div.querySelector('[data-mock-jupyter-output]')!.textContent).toBe('two');
  });

  it('a kernel that fails to connect leaves the editor, with the error said', async () => {
    const { CodeCellEditor } = await import('../index.js');
    const m = modelWith(async () => {
      throw new Error('No Pyodide here.');
    });
    const div = mount(<CodeCellEditor model={m} sheet="s1" row={1} col={1} onClose={() => {}} />);
    await tick();
    await tick();
    expect(div.querySelector('[data-cells-code-editor-kernel]')!.textContent).toBe(
      'No Pyodide here.',
    );
    expect(div.querySelector('textarea[aria-label="Source"]')).not.toBeNull();
  });

  it('the kernel indicator says not started, then follows the connection from idle to busy and back, and the model hears it', async () => {
    const { KernelStatus } = await import('../kernelStatus.js');
    const { connection, setStatus } = fakeConnection();
    const m = modelWith(async () => fakeKernel(connection));
    const div = mount(<KernelStatus model={m} menu={false} />);
    expect(
      div.querySelector('[data-cells-kernel-status]')!.getAttribute('data-cells-kernel-status'),
    ).toBe('not-started');
    expect(div.textContent).toContain('Kernel: not started');
    expect(m.kernelStatus).toBeUndefined();
    await act(async () => {
      await codeRunner(m).connect();
    });
    await tick();
    expect(
      div.querySelector('[data-cells-kernel-status]')!.getAttribute('data-cells-kernel-status'),
    ).toBe('connected');
    expect(div.textContent).toContain('Idle');
    expect(m.kernelStatus).toBe('idle');
    act(() => setStatus('busy'));
    expect(div.textContent).toContain('Busy');
    expect(m.kernelStatus).toBe('busy');
    act(() => setStatus('idle'));
    expect(div.textContent).toContain('Idle');
    expect(m.kernelStatus).toBe('idle');
    act(() => codeRunner(m).reset());
    expect(div.textContent).toContain('Kernel: not started');
    expect(m.kernelStatus).toBeUndefined();
  });
});
