/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Running code cells (C11-04), on a kernel that runs the real program in a
 * CPython subprocess: it implements the `CellsKernel` interface, each run in
 * a fresh interpreter (no IPython there, so the preamble prints its displays
 * as marker lines, which this kernel turns into `display_data` outputs).
 */

import { execFile } from 'node:child_process';
import { contribution, definePlugin } from '@datalayer/reactor';
import { describe, expect, it } from 'vitest';
import { type CellsKernel, CellsKernels } from '../../points/index.js';
import { codeCell, type CodeOutput, createCellsModel } from '../index.js';
import {
  AUTO_DEBOUNCE_MS,
  codeProgram,
  codeRunner,
  programParts,
  rangesRead,
  readOutputs,
  RESULT_MIME,
} from '../codeRun.js';

/** A kernel over `python3`: stdout's marker lines are displays, the rest a stream, a failure an error. */
function pythonKernel(flags: string[] = []): CellsKernel & { runs: number } {
  const k = {
    runs: 0,
    execute(code: string) {
      k.runs += 1;
      return new Promise<{ outputs: CodeOutput[] }>((resolve) => {
        execFile(
          'python3',
          [...flags, '-c', code],
          { timeout: 20_000 },
          (error, stdout, stderr) => {
            const outputs: CodeOutput[] = [];
            let text = '';
            for (const line of stdout.split('\n')) {
              if (line.startsWith('\u0000cells:'))
                outputs.push({
                  output_type: 'display_data',
                  data: JSON.parse(line.slice(7)),
                  metadata: {},
                });
              else if (line !== '') text += `${line}\n`;
            }
            if (text !== '') outputs.unshift({ output_type: 'stream', name: 'stdout', text });
            if (error !== null) {
              const lines = stderr.trim().split('\n');
              const last = lines[lines.length - 1] ?? '';
              outputs.push({
                output_type: 'error',
                ename: last.split(':')[0],
                evalue: last.split(':').slice(1).join(':').trim(),
                traceback: lines,
              });
            }
            resolve({ outputs });
          },
        );
      });
    },
  };
  return k;
}

function setup(kernel: CellsKernel | undefined) {
  const plugins =
    kernel === undefined
      ? []
      : [
          definePlugin({
            name: 'test-python',
            contributes: [
              contribution(
                CellsKernels,
                { id: 'python', label: 'CPython', connect: async () => kernel },
                { id: 'python' },
              ),
            ],
          }),
        ];
  const m = createCellsModel({ limits: { rows: 50, cols: 10 }, plugins });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 0, col: 0 },
    cells: Array.from({ length: 10 }, (_, r) => [r + 1, (r + 1) * 10]),
  });
  return m;
}

const SUM = `data = cells["A1:B10"]
rows = data.values.tolist() if hasattr(data, "values") else data
sum(v for row in rows for v in row if v is not None)`;

const COLUMN = `rows = cells["A1:A10"]
rows = rows.values.tolist() if hasattr(rows, "values") else rows
sum(r[0] for r in rows)`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('running code cells', () => {
  it('reads the literal ranges of a source', () => {
    expect(rangesRead(`x = cells["A1:B10"] + cells['Sheet2!C3']\ncells["A1:B10"]`)).toEqual([
      'A1:B10',
      'Sheet2!C3',
    ]);
  });

  it("gives a program's data and source back to a kernel that is not Python", () => {
    const source = 'x = ", "\nx';
    expect(programParts(codeProgram(source, { 'A1:A2': [[1], [2]] }))).toEqual({
      data: { 'A1:A2': [[1], [2]] },
      source,
    });
  });

  it('takes the result out of the outputs, and an error is #ERROR!', () => {
    const result = { output_type: 'display_data', data: { [RESULT_MIME]: { result: 6 } } } as const;
    expect(readOutputs([result])).toEqual({ result: 6, outputs: [] });
    const error = { output_type: 'error', ename: 'E', evalue: '', traceback: [] } as const;
    expect(readOutputs([error]).result).toEqual({ error: '#ERROR!' });
  });

  it('computes from A1:B10, a formula reads the result, editing A3 marks it stale', async () => {
    const kernel = pythonKernel();
    const m = setup(kernel);
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 0, col: 2, code: codeCell(SUM) });
    m.dispatch({
      type: 'SET_CELLS',
      sheet: 's1',
      at: { row: 0, col: 3 },
      cells: [[{ formula: 'C1*2' }]],
    });
    await codeRunner(m).run({ sheet: 's1', row: 0, col: 2 });
    expect(m.value('s1', 0, 2)).toBe(605);
    expect(m.value('s1', 0, 3)).toBe(1210);
    expect(m.code('s1', 0, 2)?.executionCount).toBe(1);
    expect(m.code('s1', 0, 2)?.lastRun).toBeDefined();
    expect(m.code('s1', 0, 2)?.outputs).toEqual([]);
    // The run is one undo step.
    m.undo();
    expect(m.value('s1', 0, 2)).toBeNull();
    m.redo();
    expect(m.codeState('s1', 0, 2)).toBeUndefined();
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 0 }, cells: [[100]] });
    expect(m.codeState('s1', 0, 2)).toBe('stale');
    expect(kernel.runs).toBe(1);
  });

  it('an auto cell runs again once after a change, debounced', async () => {
    const kernel = pythonKernel();
    const m = setup(kernel);
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 0,
      col: 4,
      code: codeCell(COLUMN, { run: 'auto' }),
    });
    await codeRunner(m).run({ sheet: 's1', row: 0, col: 4 });
    expect(m.value('s1', 0, 4)).toBe(55);
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 2, col: 0 }, cells: [[100]] });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 3, col: 0 }, cells: [[4]] });
    await wait(AUTO_DEBOUNCE_MS + 100);
    await expect.poll(() => m.value('s1', 0, 4), { timeout: 20_000 }).toBe(152);
    await wait(AUTO_DEBOUNCE_MS + 100);
    expect(kernel.runs).toBe(2);
  }, 30_000);

  it('reads a range as rows where pandas is absent (no site packages)', async () => {
    const m = setup(pythonKernel(['-S']));
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 0, col: 2, code: codeCell(SUM) });
    await codeRunner(m).run({ sheet: 's1', row: 0, col: 2 });
    expect(m.value('s1', 0, 2)).toBe(605);
  });

  it('an exception is #ERROR! with the traceback in the outputs', async () => {
    const m = setup(pythonKernel());
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 0, col: 2, code: codeCell('1/0') });
    await codeRunner(m).run({ sheet: 's1', row: 0, col: 2 });
    expect(m.value('s1', 0, 2)).toEqual({ error: '#ERROR!' });
    const error = m.code('s1', 0, 2)!.outputs.find((o) => o.output_type === 'error')!;
    expect(error.ename).toBe('ZeroDivisionError');
  });

  it('says a refused result instead of landing nowhere (an output without its output_type)', async () => {
    const bare: CellsKernel = {
      execute: async () => ({
        outputs: [{ data: { 'text/plain': 'x' }, metadata: {} } as never],
      }),
    };
    const m = setup(bare);
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 0, col: 2, code: codeCell('x') });
    await expect(codeRunner(m).run({ sheet: 's1', row: 0, col: 2 })).rejects.toThrow(
      "The run's result was refused",
    );
    expect(m.codeState('s1', 0, 2)).toBeUndefined();
  });

  it('says No kernel when none is contributed', async () => {
    const m = setup(undefined);
    m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 0, col: 2, code: codeCell('1') });
    await expect(m.reactor.executeCommand('cells.code.run', { model: m })).rejects.toThrow(
      'No kernel',
    );
  });
});
