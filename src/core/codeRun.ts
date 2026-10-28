/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Running code cells (§3.13, C11-04). A run sends the kernel a program: a
 * preamble defining `cells`, whose `cells["A1:B10"]` is the range's values
 * (a pandas DataFrame when pandas is there, rows otherwise; a single cell is
 * its value), then the cell's source with its last expression's value
 * displayed under the Cells result type. The result is written back with
 * `SET_CODE` (one undo step); an exception is `#ERROR!` with the traceback
 * in the outputs. The ranges a source reads (`cells["…"]` with a literal
 * reference) are its precedents: when what they hold changes after a run, a
 * `manual` cell is marked stale and an `auto` cell runs again, debounced,
 * one at a time, in dependency order. Nothing runs on open; the engine
 * never runs code itself.
 *
 * @module core/codeRun
 */

import type { ReactorPlatform } from '@datalayer/reactor';
import {
  type CellsKernel,
  CellsCodeRenderer,
  CellsKernels,
  type CodeRenderer,
  type KernelProvider,
  optionalContribution,
  type Resolved,
} from '../points/index.js';
import { type CodeCell, type CodeOutput, type CodeResult, codeCells, codeKey } from './code.js';
import type { CellsModel } from './model.js';
import type { CellValue } from './values.js';
import { isCellError } from './values.js';
import { parseZone, splitSheet, type Zone, zoneContains } from './zone.js';

/** The mime type a run's result travels under, in a `display_data` output the runner takes out. */
export const RESULT_MIME = 'application/vnd.datalayer.cells.result+json';

/** The literal ranges a source reads: `cells["A1:B10"]`, `cells['Sheet2!C3']`. */
export function rangesRead(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bcells\s*\[\s*(["'])([^"'\]]+)\1\s*\]/g)) out.add(m[2]);
  return [...out];
}

/** A range read by a code cell on `sheet`: its sheet id and zone, or `undefined` when it names nothing. */
export function resolveRead(
  model: CellsModel,
  sheet: string,
  ref: string,
): { sheet: string; zone: Zone } | undefined {
  try {
    const { sheet: name, ref: a1 } = splitSheet(ref);
    const id = name === undefined ? sheet : model.workbook.sheets.find((s) => s.name === name)?.id;
    if (id === undefined) return undefined;
    return { sheet: id, zone: parseZone(a1) };
  } catch {
    return undefined;
  }
}

const json = (v: CellValue) => (v === null || isCellError(v) ? null : v);

/** The values a code cell's ranges hold, as the preamble sends them (errors as `None`). */
export function readValues(
  model: CellsModel,
  sheet: string,
  source: string,
): Record<string, (string | number | boolean | null)[][]> {
  const out: Record<string, (string | number | boolean | null)[][]> = {};
  for (const ref of rangesRead(source)) {
    const at = resolveRead(model, sheet, ref);
    if (at === undefined) continue;
    out[ref] = model.toRows(at.zone, at.sheet).map((row) => row.map(json));
  }
  return out;
}

/** The program a run sends: the preamble, the data, the source and the result's display. */
export function codeProgram(source: string, data: Record<string, unknown>): string {
  return `${PREAMBLE}
__cells_run(${JSON.stringify(JSON.stringify(data))}, ${JSON.stringify(source)})
`;
}

/** A program's data and source back, for a kernel that is not Python (a host's own, a test's); `undefined` for any other code. */
export function programParts(
  code: string,
): { data: Record<string, unknown[][]>; source: string } | undefined {
  const last = code.trimEnd().split('\n').pop() ?? '';
  if (!last.startsWith('__cells_run("') || !last.endsWith('")')) return undefined;
  const args = last.slice('__cells_run('.length, -1);
  // Two JSON strings: the split is the first `", "` after which both parse.
  for (let at = args.indexOf('", "'); at >= 0; at = args.indexOf('", "', at + 1)) {
    try {
      const data = JSON.parse(JSON.parse(args.slice(0, at + 1)));
      const source = JSON.parse(args.slice(at + 3));
      if (typeof source === 'string') return { data, source };
    } catch {
      // Not this split.
    }
  }
  return undefined;
}

/**
 * The preamble: `cells[...]` over the sent values, the source run with its
 * last expression evaluated, the value displayed (a DataFrame or a figure as
 * itself) and its result as `RESULT_MIME`. IPython's `display` inside a
 * kernel (every Jupyter kernel), a printed marker line in a bare interpreter.
 */
export const PREAMBLE = String.raw`def __cells_run(__data, __source):
    import ast as _ast, json as _json, math as _math
    try:
        from IPython import get_ipython as _ip
        from IPython.display import display as _show
        if _ip() is None:
            raise ImportError("no kernel")
        def _emit(bundle):
            _show(bundle, raw=True)
    except ImportError:
        _show = print
        def _emit(bundle):
            print("\x00cells:" + _json.dumps(bundle))
    _data = _json.loads(__data)
    class _Cells:
        def __getitem__(self, ref):
            rows = _data[ref]
            if len(rows) == 1 and len(rows[0]) == 1:
                return rows[0][0]
            try:
                import pandas as _pd
            except ImportError:
                return rows
            head = rows[0]
            if len(rows) > 1 and all(isinstance(h, str) for h in head) and any(
                not isinstance(v, str) for r in rows[1:] for v in r if v is not None
            ):
                return _pd.DataFrame(rows[1:], columns=head)
            return _pd.DataFrame(rows)
    _g = globals()
    _g["cells"] = _Cells()
    tree = _ast.parse(__source)
    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], _ast.Expr) else None
    exec(compile(tree, "<cell>", "exec"), _g)
    value = eval(compile(_ast.Expression(last.value), "<cell>", "eval"), _g) if last else None
    if hasattr(value, "item") and callable(value.item) and getattr(value, "shape", None) == ():
        value = value.item()
    if value is None or isinstance(value, (bool, int, float, str)):
        if isinstance(value, float) and not _math.isfinite(value):
            result = {"error": "#NUM!"}
        else:
            result = value
    else:
        _show(value)
        shape = getattr(value, "shape", None)
        kind = type(value).__name__
        result = kind + (" (" + " × ".join(str(n) for n in shape) + ")" if isinstance(shape, tuple) else "")
    _emit({${JSON.stringify(RESULT_MIME)}: {"result": result}})
`;

/** A run's outputs, with the result's own output taken out: the result, and what the frame shows. */
export function readOutputs(outputs: readonly CodeOutput[]): {
  result: CodeResult;
  outputs: CodeOutput[];
} {
  let result: CodeResult = null;
  let failed = false;
  const shown: CodeOutput[] = [];
  for (const o of outputs) {
    const data = (o as { data?: Record<string, unknown> }).data;
    const carried = data?.[RESULT_MIME] as { result?: CodeResult } | undefined;
    if (carried !== undefined) {
      result = carried.result ?? null;
      continue;
    }
    if (o.output_type === 'error') failed = true;
    shown.push(o);
  }
  return { result: failed ? { error: '#ERROR!' } : result, outputs: shown };
}

/** A fingerprint of what a code cell reads, to tell when it changed since its run. */
function fingerprint(model: CellsModel, sheet: string, source: string): string {
  return JSON.stringify(readValues(model, sheet, source));
}

/** The code renderer a platform resolves (the first in `order`), or `undefined`. */
export function codeRendererOf(reactor: ReactorPlatform): Resolved<CodeRenderer> | undefined {
  return optionalContribution(reactor, CellsCodeRenderer, 'code renderer');
}

/** Where a code cell is: its sheet and position. */
export interface CodePlace {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
}

/** How long an `auto` cell waits after a change before it runs again, ms. */
export const AUTO_DEBOUNCE_MS = 300;

/**
 * The runner of one model's code cells: it connects the kernel on the first
 * run (always a person's gesture), runs one cell at a time, writes results
 * back, and watches what the cells read.
 */
export class CodeRunner {
  readonly model: CellsModel;
  #kernel: Promise<CellsKernel> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #seen = new Map<string, string>();
  #count = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stop: () => void;
  readonly #kernelId: string | undefined;

  constructor(model: CellsModel, options: { kernel?: string } = {}) {
    this.model = model;
    this.#kernelId = options.kernel;
    this.#stop = model.subscribe((tx) => {
      if (tx.origin === 'code' || tx.label === 'Run code') return;
      this.#check();
    });
  }

  /** The kernel provider runs go to: the one named, or the first contributed. */
  provider(): KernelProvider | undefined {
    const all = this.model.reactor.getContributions(CellsKernels).map((c) => c.value);
    return this.#kernelId === undefined ? all[0] : all.find((k) => k.id === this.#kernelId);
  }

  /** The kernel, connected on first use (one per model: an editor and the runs share it). Refused with no kernel. */
  connect(): Promise<CellsKernel> {
    const provider = this.provider();
    if (provider === undefined) return Promise.reject(new Error(NO_KERNEL));
    this.#kernel ??= provider.connect().catch((error: unknown) => {
      this.#kernel = undefined;
      throw error;
    });
    return this.#kernel;
  }

  /** Run one code cell; resolves once its result is written. Refused (thrown) with no kernel. */
  run(place: CodePlace): Promise<void> {
    const provider = this.provider();
    if (provider === undefined) return Promise.reject(new Error(NO_KERNEL));
    const run = this.#queue.then(() => this.#runNow(provider, place));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Run every code cell of a sheet, in dependency order. */
  async runAll(sheet: string): Promise<void> {
    for (const place of this.#ordered(sheet, () => true)) await this.run(place);
  }

  /** Forget the kernel (a host switched kernels): the next run connects to the provider of that moment. The old kernel is not shut down. */
  reset(): void {
    this.#kernel = undefined;
  }

  /** Interrupt the run in flight. */
  async interrupt(): Promise<void> {
    if (this.#kernel === undefined) return;
    await (await this.#kernel).interrupt?.();
  }

  /** Stop watching the model. */
  dispose(): void {
    this.#stop();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }

  async #runNow(provider: KernelProvider, place: CodePlace): Promise<void> {
    const m = this.model;
    const code = m.code(place.sheet, place.row, place.col);
    if (code === undefined) throw new Error('No code cell here.');
    void provider;
    const kernel = await this.connect();
    const sheet = m.workbook.sheet(place.sheet);
    const key = codeKey(sheet, place.row, place.col);
    const data = readValues(m, place.sheet, code.source);
    m.setCodeState(place.sheet, place.row, place.col, 'running');
    let after: CodeCell;
    try {
      const reply = await kernel.execute(codeProgram(code.source, data));
      const { result, outputs } = readOutputs(reply.outputs);
      this.#count += 1;
      after = {
        ...code,
        outputs,
        result,
        executionCount: reply.executionCount ?? this.#count,
        lastRun: new Date().toISOString(),
      };
    } catch (error) {
      after = {
        ...code,
        outputs: [
          {
            output_type: 'error',
            ename: 'KernelError',
            evalue: (error as Error).message,
            traceback: [(error as Error).message],
          },
        ],
        result: { error: '#ERROR!' },
        lastRun: new Date().toISOString(),
      };
    }
    // The cell may have moved while it ran: write where its key is now.
    const at = codeCells(sheet).find((c) => codeKey(sheet, c.row, c.col) === key);
    m.setCodeState(place.sheet, place.row, place.col, undefined);
    if (at === undefined) return;
    m.transact('Run code', () =>
      m.dispatch({ type: 'SET_CODE', sheet: place.sheet, row: at.row, col: at.col, code: after }),
    );
    this.#seen.set(`${place.sheet}:${key}`, fingerprint(m, place.sheet, after.source));
    this.#check();
  }

  /** The code cells of a sheet matching `which`, a cell read by another after it. */
  #ordered(sheet: string, which: (c: CodeCell) => boolean): CodePlace[] {
    const m = this.model;
    const all = codeCells(m.workbook.sheet(sheet)).filter((c) => which(c.code));
    const reads = all.map((c) =>
      rangesRead(c.code.source)
        .map((r) => resolveRead(m, sheet, r))
        .filter((z) => z !== undefined && z.sheet === sheet)
        .map((z) => z!.zone),
    );
    const before = (i: number, j: number) =>
      reads[j].some((z) => zoneContains(z, { row: all[i].row, col: all[i].col }));
    const done = new Set<number>();
    const out: CodePlace[] = [];
    while (done.size < all.length) {
      let next = all.findIndex(
        (_, j) => !done.has(j) && all.every((_c, i) => i === j || done.has(i) || !before(i, j)),
      );
      if (next < 0) next = all.findIndex((_, j) => !done.has(j)); // a cycle: reading order
      done.add(next);
      out.push({ sheet, row: all[next].row, col: all[next].col });
    }
    return out;
  }

  /** After a change: mark stale what changed under a run, and schedule the `auto` cells. */
  #check(): void {
    const m = this.model;
    const auto: string[] = [];
    for (const sheet of m.workbook.sheets) {
      for (const c of codeCells(sheet)) {
        const key = `${sheet.id}:${codeKey(sheet, c.row, c.col)}`;
        const seen = this.#seen.get(key);
        if (seen === undefined) continue; // never run here: nothing to compare with
        if (m.codeState(sheet.id, c.row, c.col) === 'running') continue;
        if (fingerprint(m, sheet.id, c.code.source) === seen) continue;
        if (c.code.run === 'auto') auto.push(sheet.id);
        else m.setCodeState(sheet.id, c.row, c.col, 'stale');
      }
    }
    if (auto.length === 0) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      for (const sheet of new Set(auto))
        for (const place of this.#ordered(sheet, (c) => c.run === 'auto')) {
          const s = m.workbook.sheet(sheet);
          const key = `${sheet}:${codeKey(s, place.row, place.col)}`;
          const code = m.code(sheet, place.row, place.col);
          if (code === undefined || this.#seen.get(key) === fingerprint(m, sheet, code.source))
            continue;
          this.#seen.set(key, fingerprint(m, sheet, code.source));
          void this.run(place).catch(() => undefined);
        }
    }, AUTO_DEBOUNCE_MS);
  }
}

const runners = new WeakMap<CellsModel, CodeRunner>();

/** The runner of a model's code cells, made on first use. */
export function codeRunner(model: CellsModel): CodeRunner {
  let r = runners.get(model);
  if (r === undefined) runners.set(model, (r = new CodeRunner(model)));
  return r;
}

/** What a run says when no kernel is contributed. */
export const NO_KERNEL = 'No kernel';
