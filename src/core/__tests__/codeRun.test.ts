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

  /**
   * A kernel as the live workbook is: each cell's program (by the name the
   * runner gives it) reads and writes the model (a write is a `Code: <cell>`
   * transaction, as the comm applies one) and reports what it read and wrote.
   * `late`: the writes land after the result, as a comm's may.
   */
  function liveKernel(
    m: ReturnType<typeof setup>,
    programs: Record<string, () => { reads: string[]; writes: [string, number, number, number][] }>,
    late = false,
  ): CellsKernel & { runs: Record<string, number> } {
    const runs: Record<string, number> = {};
    return {
      runs,
      execute: async (code: string) => {
        const last = code.trimEnd().split('\n').pop()!;
        const origin = JSON.parse(last.slice(last.lastIndexOf(', "') + 2, -1)) as string;
        runs[origin] = (runs[origin] ?? 0) + 1;
        const { reads, writes } = programs[origin]();
        const write = () =>
          m.transact(`Code: ${origin}`, () => {
            for (const [, row, col, value] of writes)
              m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row, col }, cells: [[value]] });
          });
        if (late) setTimeout(write, 50);
        else write();
        return {
          outputs: [
            {
              output_type: 'display_data',
              data: {
                [RESULT_MIME]: { result: runs[origin], reads, writes: writes.map(([r]) => r) },
              },
              metadata: {},
            },
          ],
        };
      },
    };
  }

  function kernelOf(kernel: CellsKernel) {
    return definePlugin({
      name: 'test-live',
      contributes: [
        contribution(
          CellsKernels,
          { id: 'live', label: 'Live', connect: async () => kernel },
          { id: 'live' },
        ),
      ],
    });
  }

  it("an auto cell's own writes, inside what it reads, never run it again; a person's edit does", async () => {
    let kernel: ReturnType<typeof liveKernel> | undefined;
    const m = createCellsModel({
      limits: { rows: 20, cols: 10 },
      plugins: [kernelOf({ execute: (code) => kernel!.execute(code) })],
    });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1], [2], [3]] });
    // E1 reads A1:A3 and writes A2 (a new value every run), the write landing after its result.
    kernel = liveKernel(
      m,
      {
        'Sheet1!E1': () => ({
          reads: ['Sheet1!A1:A3'],
          writes: [['Sheet1!A2', 1, 0, 100 + (kernel!.runs['Sheet1!E1'] ?? 0)]],
        }),
      },
      true,
    );
    m.dispatch({
      type: 'SET_CODE',
      sheet: 's1',
      row: 0,
      col: 4,
      code: codeCell('x', { run: 'auto' }),
    });
    await codeRunner(m).run({ sheet: 's1', row: 0, col: 4 });
    await wait(AUTO_DEBOUNCE_MS * 3);
    expect(kernel.runs['Sheet1!E1']).toBe(1);
    // A person edits A1: it runs again, once.
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[7]] });
    await wait(AUTO_DEBOUNCE_MS * 3);
    expect(kernel.runs['Sheet1!E1']).toBe(2);
    expect(m.codeState('s1', 0, 4)).toBeUndefined();
  });

  it('two auto cells writing what the other reads run once each per change, then wait stale', async () => {
    let kernel: ReturnType<typeof liveKernel> | undefined;
    const m = createCellsModel({
      limits: { rows: 20, cols: 10 },
      plugins: [kernelOf({ execute: (code) => kernel!.execute(code) })],
    });
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[1, 1]] });
    const v = (col: number) => m.value('s1', 0, col) as number;
    // E1 reads A1 and writes B1 = A1 + 1; E2 reads B1 and writes A1 = B1 + 1.
    kernel = liveKernel(m, {
      'Sheet1!E1': () => ({ reads: ['Sheet1!A1'], writes: [['Sheet1!B1', 0, 1, v(0) + 1]] }),
      'Sheet1!E2': () => ({ reads: ['Sheet1!B1'], writes: [['Sheet1!A1', 0, 0, v(1) + 1]] }),
    });
    for (const row of [0, 1])
      m.dispatch({
        type: 'SET_CODE',
        sheet: 's1',
        row,
        col: 4,
        code: codeCell('x', { run: 'auto' }),
      });
    await codeRunner(m).run({ sheet: 's1', row: 0, col: 4 });
    await codeRunner(m).run({ sheet: 's1', row: 1, col: 4 });
    await wait(AUTO_DEBOUNCE_MS * 6);
    const after = { ...kernel.runs };
    // Nothing runs on by itself any more.
    await wait(AUTO_DEBOUNCE_MS * 4);
    expect(kernel.runs).toEqual(after);
    // A person's edit of A1: E1 runs, its write runs E2, whose write would run E1 again: it waits, stale.
    const before = { ...kernel.runs };
    m.dispatch({ type: 'SET_CELLS', sheet: 's1', at: { row: 0, col: 0 }, cells: [[50]] });
    await wait(AUTO_DEBOUNCE_MS * 8);
    expect(kernel.runs['Sheet1!E1'] - before['Sheet1!E1']).toBe(1);
    expect(kernel.runs['Sheet1!E2'] - before['Sheet1!E2']).toBe(1);
    expect(m.codeState('s1', 0, 4)).toBe('stale');
    expect(v(1)).toBe(51);
    expect(v(0)).toBe(52);
  }, 20_000);
});
