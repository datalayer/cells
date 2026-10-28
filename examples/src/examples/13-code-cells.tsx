/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin, type PlatformInput } from '@datalayer/reactor';
import {
  buildCellsReactor,
  type CellsModel,
  CellsKernels,
  codeCell,
  codeRunner,
  createCellsModel,
  fromRows,
  type KernelProvider,
  Spreadsheet,
  useCellsRevision,
  CellsProvider,
} from '@datalayer/cells';
import { SegmentedControl } from '@primer/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Frame } from '../shared';

/** Where the code runs: the browser's Pyodide, or an anonymous Jupyter server on prod1. */
export type KernelTarget = 'browser' | 'jupyter';

/** The two kernels of this page, with what each is. */
export const KERNEL_TARGETS: readonly { id: KernelTarget; label: string; hint: string }[] = [
  {
    id: 'browser',
    label: 'Browser',
    hint: 'Python in this page (Pyodide through JupyterLite): nothing to install, nobody signed in; the first run downloads it.',
  },
  {
    id: 'jupyter',
    label: 'Jupyter (prod1)',
    hint: 'An anonymous Jupyter server on prod1.datalayer.run. Sandbox only — no agent, no account.',
  },
];

/** Where the choice is kept between visits. */
export const KERNEL_TARGET_KEY = 'cells-examples-kernel';

/** The kept choice, Browser by default. */
export function readKernelTarget(): KernelTarget {
  try {
    const v = window.localStorage.getItem(KERNEL_TARGET_KEY);
    return v === 'jupyter' ? 'jupyter' : 'browser';
  } catch {
    return 'browser';
  }
}

/** The names of the two plugins, one per kernel; one is enabled at a time. */
export const KERNEL_PLUGIN: Record<KernelTarget, string> = {
  browser: '@datalayer/cells-jupyter',
  jupyter: '@datalayer/cells-examples-jupyter-prod1',
};

const PROD1_URL = 'https://prod1.datalayer.run/api/jupyter-server';
// An anonymous public sandbox (the one the jupyter-react examples use): no agent, no account.
const PROD1_TOKEN = '60c1661cc408f978c309d04157af55c9588ff9557c9380e4fb50785750703da6';

/** The `./jupyter` entry, fetched once (it carries jupyter-react; JupyterLite and Pyodide come with the first run). */
const jupyter = () => import('@datalayer/cells/jupyter');

/** The browser kernel: JupyterLite's Pyodide, the page as its server (an empty token). */
export function browserKernel(): KernelProvider {
  return {
    id: 'lite',
    label: 'Python in the browser (Pyodide)',
    async connect() {
      const [{ liteKernel }, { setJupyterServerToken, setJupyterServerUrl }] = await Promise.all([
        jupyter(),
        import('@datalayer/jupyter-react/core'),
      ]);
      setJupyterServerUrl(window.location.origin);
      setJupyterServerToken('');
      return liteKernel().connect();
    },
  };
}

/** The prod1 kernel: a `ServiceManager` on the anonymous server, built on the first run. */
export function prod1Kernel(): KernelProvider {
  return {
    id: 'prod1',
    label: 'Jupyter on prod1 (anonymous)',
    async connect() {
      const [{ serviceManagerKernel }, core, { ServiceManager }] = await Promise.all([
        jupyter(),
        import('@datalayer/jupyter-react/core'),
        import('@jupyterlab/services'),
      ]);
      core.setJupyterServerUrl(PROD1_URL);
      core.setJupyterServerToken(PROD1_TOKEN);
      const serverSettings = core.createServerSettings(PROD1_URL, PROD1_TOKEN);
      return serviceManagerKernel(new ServiceManager({ serverSettings }), {
        id: 'prod1',
        label: 'Jupyter on prod1 (anonymous)',
      }).connect();
    },
  };
}

/** The two kernel plugins; the renderer (jupyter-react's `Output` and `Cell`) arrives with the browser one, through `./jupyter`. */
export function kernelPlugins(
  providers: { browser: KernelProvider; jupyter: KernelProvider } = {
    browser: browserKernel(),
    jupyter: prod1Kernel(),
  },
): PlatformInput[] {
  return [
    definePlugin({
      name: KERNEL_PLUGIN.browser,
      displayName: 'Jupyter (browser)',
      description: KERNEL_TARGETS[0].hint,
      octicon: 'browser',
      contributes: [contribution(CellsKernels, providers.browser, { id: providers.browser.id })],
    }),
    definePlugin({
      name: KERNEL_PLUGIN.jupyter,
      displayName: 'Jupyter (prod1)',
      description: KERNEL_TARGETS[1].hint,
      octicon: 'server',
      contributes: [contribution(CellsKernels, providers.jupyter, { id: providers.jupyter.id })],
    }),
  ];
}

const SUM = `data = cells["B2:B7"]
rows = data.values.tolist() if hasattr(data, "values") else data
sum(r[0] for r in rows)`;

const PLOT = `import io
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
from IPython.display import Image
data = cells["A1:B7"]
fig, ax = plt.subplots(figsize=(4.2, 2.6))
ax.bar(data["Month"], data["Units"], color="#0969da")
ax.set_title("Units by month")
buf = io.BytesIO()
fig.savefig(buf, format="png", dpi=80, bbox_inches="tight")
plt.close(fig)
Image(buf.getvalue())`;

/** The page's grid: a small table, a code cell summing it (C2), one plotting it beside the cells (C4). */
export function codeCellsModel(plugins: readonly PlatformInput[] = kernelPlugins()): CellsModel {
  const reactor = buildCellsReactor(plugins);
  const m = createCellsModel({
    reactor,
    data: fromRows([
      ['Month', 'Units', 'Total', 'Note'],
      ['Jan', 12, null, 'C2 sums B2:B7 in Python; D2 reads it as =C2*2'],
      ['Feb', 15],
      ['Mar', 19, null, 'C4 plots the table: its figure shows beside the cells'],
      ['Apr', 24],
      ['May', 28],
      ['Jun', 31],
    ]),
  });
  m.dispatch({ type: 'SET_CODE', sheet: 's1', row: 1, col: 2, code: codeCell(SUM) });
  m.dispatch({
    type: 'SET_CELLS',
    sheet: 's1',
    at: { row: 1, col: 3 },
    cells: [[{ formula: 'C2*2' }]],
  });
  m.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row: 3,
    col: 2,
    code: codeCell(PLOT, { frame: { width: 380, height: 240 } }),
  });
  m.dispatch({
    type: 'RESIZE_AXIS',
    sheet: 's1',
    axis: 'cols',
    from: 2,
    to: 2,
    size: 120,
  });
  m.select({
    sheet: 's1',
    zones: [{ top: 1, left: 2, bottom: 1, right: 2 }],
    anchor: { row: 1, col: 2 },
    active: { row: 1, col: 2 },
  });
  return m;
}

/** Switch the grid's kernel: one plugin enabled, the other off, and the runner forgets its kernel. */
export function switchKernel(model: CellsModel, target: KernelTarget): void {
  for (const t of KERNEL_TARGETS) {
    const name = KERNEL_PLUGIN[t.id];
    if (t.id === target) {
      if (!model.reactor.isEnabled(name)) model.reactor.enable(name);
    } else if (model.reactor.isEnabled(name)) model.reactor.disable(name);
  }
  codeRunner(model).reset();
}

function Status({ model }: { model: CellsModel }) {
  useCellsRevision();
  const sum = model.code('s1', 1, 2);
  const plot = model.code('s1', 3, 2);
  const state = (row: number) => model.codeState('s1', row, 2);
  const line = (name: string, c: typeof sum, s: ReturnType<typeof state>) =>
    `${name}: ${s === 'running' ? 'running' : c?.lastRun === undefined ? 'not run yet' : `run ${c.executionCount ?? ''} at ${new Date(c.lastRun).toLocaleTimeString()}${s === 'stale' ? ', stale' : ''}`}`;
  return (
    <p data-code-status="">
      {line('C2', sum, state(1))} · {line('C4', plot, state(3))}
    </p>
  );
}

/**
 * Code cells (§3.13): a cell holds Python; Shift+Enter runs it on a Jupyter
 * kernel, its result is a value the formulas read, and its rich outputs (a
 * figure) show in a frame beside the cells, drawn by jupyter-react's
 * `Output`. F4 opens the source in jupyter-react's `Cell`, on the same
 * kernel. The kernel is the browser's Pyodide (no account) or an anonymous
 * Jupyter server on prod1; the choice is kept between visits.
 */
export default function CodeCells(props: { readonly plugins?: readonly PlatformInput[] }) {
  const [model] = useState(() => codeCellsModel(props.plugins));
  const [target, setTarget] = useState<KernelTarget>(readKernelTarget);
  const [message, setMessage] = useState('');
  useEffect(() => {
    switchKernel(model, target);
    try {
      window.localStorage.setItem(KERNEL_TARGET_KEY, target);
    } catch {
      // A private window: the choice lasts the visit.
    }
  }, [model, target]);
  const run = useCallback(
    (id: string) => {
      setMessage('');
      model.reactor.executeCommand(id, { model }).catch((error: Error) => {
        setMessage(error.message);
      });
    },
    [model],
  );
  const hint = useMemo(() => KERNEL_TARGETS.find((t) => t.id === target)!.hint, [target]);
  return (
    <CellsProvider model={model}>
      <p>
        C2 and C4 are code cells (the badge): click one and press Shift+Enter to run it, or F4 to
        open its source in jupyter-react&apos;s <code>Cell</code>. C2&apos;s result lands in the
        grid, where D2 reads it; C4&apos;s figure shows in a frame beside the cells. Edit B2:B7 and
        the cells turn stale until they run again.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span id="kernel-label">Kernel:</span>
        <SegmentedControl aria-labelledby="kernel-label" size="small">
          {KERNEL_TARGETS.map((t) => (
            <SegmentedControl.Button
              key={t.id}
              selected={target === t.id}
              title={t.hint}
              onClick={() => setTarget(t.id)}
            >
              {t.label}
            </SegmentedControl.Button>
          ))}
        </SegmentedControl>
        <button type="button" onClick={() => run('cells.code.runAll')}>
          Run all
        </button>
        <button type="button" onClick={() => run('cells.code.interrupt')}>
          Interrupt
        </button>
      </div>
      <p data-kernel-hint="">{hint}</p>
      <Frame height={360}>
        <Spreadsheet model={model} aria-label="Units by month" />
      </Frame>
      <Status model={model} />
      {message !== '' && <p data-code-message="">{message}</p>}
    </CellsProvider>
  );
}
