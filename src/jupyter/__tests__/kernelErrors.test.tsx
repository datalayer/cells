/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @vitest-environment jsdom

/**
 * An exception in a code cell run on a Jupyter kernel is the run's outcome,
 * not a kernel failure: jupyter-react rejects its executor's `done` with a
 * string on an error reply, and `jupyterKernel` answers the outputs with the
 * Python error (its name, value and traceback) rather than throwing, so the
 * cell reads `#ERROR!` with the traceback, as on any kernel. Seen in Chrome:
 * a refused spill came back as `KernelError` with no message. jupyter-react
 * is mocked (its packages do not load in jsdom).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@datalayer/jupyter-react', () => ({
  Cell: () => null,
  Output: () => null,
  cellsStore: { getState: () => ({ getSource: () => undefined }) },
  createLiteServiceManager: async () => ({}),
  jupyterReactStore: { getState: () => ({ serviceManager: {}, setServiceManager: () => {} }) },
  Kernel: class {},
  ServiceManagerLess: class {},
}));
vi.mock('../sourceCell.js', () => ({ SourceCell: () => null }));
vi.mock('@datalayer/jupyter-react/theme', () => ({ JupyterReactTheme: () => null }));
vi.mock('@datalayer/jupyter-react/kernel-indicator', () => ({ KernelIndicator: () => null }));

const { jupyterKernel } = await import('../index.js');

/** A jupyter-react `Kernel` whose one execution ends as `done` says, with `outputs` in its output model. */
function kernelOf(done: Promise<unknown>, outputs: unknown[]) {
  done.catch(() => undefined);
  return {
    execute: () => ({ done, model: { toJSON: () => outputs } }),
  } as unknown as Parameters<typeof jupyterKernel>[0];
}

const SPILL =
  'SpillError: #SPILL!: E1 is not empty.\nTraceback (most recent call last):\n  File "<cell>", line 2';

describe('jupyterKernel on an error reply', () => {
  it('answers the error as an output when the output model has none yet', async () => {
    const stream = { output_type: 'stream', name: 'stdout', text: 'before\n' };
    const k = jupyterKernel(kernelOf(Promise.reject(SPILL), [stream]));
    const { outputs } = await k.execute('cells["E1:F3"] = df');
    expect(outputs).toEqual([
      stream,
      {
        output_type: 'error',
        ename: 'SpillError',
        evalue: '#SPILL!: E1 is not empty.',
        traceback: ['Traceback (most recent call last):', '  File "<cell>", line 2'],
      },
    ]);
  });

  it('keeps the error output the kernel sent', async () => {
    const error = {
      output_type: 'error',
      ename: 'ZeroDivisionError',
      evalue: 'division by zero',
      traceback: ['…'],
    };
    const k = jupyterKernel(
      kernelOf(Promise.reject('ZeroDivisionError: division by zero\n…'), [error]),
    );
    expect((await k.execute('1/0')).outputs).toEqual([error]);
  });

  it('still fails on an aborted execution, and answers a plain run as it was', async () => {
    await expect(
      jupyterKernel(kernelOf(Promise.reject('Execution aborted.'), [])).execute('x'),
    ).rejects.toThrow('Execution aborted.');
    const result = { output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {} };
    expect(
      (await jupyterKernel(kernelOf(Promise.resolve(), [result])).execute('42')).outputs,
    ).toEqual([result]);
  });
});
