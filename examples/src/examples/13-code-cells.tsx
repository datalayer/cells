/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { contribution, definePlugin, type PlatformInput } from '@datalayer/reactor';
import {
  buildCellsReactor,
  type CellsModel,
  CellsCodeRenderer,
  CellsKernels,
  type CodeRenderer,
  codeCell,
  codeRunner,
  createCellsModel,
  fromRows,
  type KernelProvider,
  Spreadsheet,
  useCellsRevision,
  CellsProvider,
} from '@datalayer/cells';
import { LoroBinding } from '@datalayer/cells/collab';
import { LoroDoc } from 'loro-crdt';
import { Button, SegmentedControl } from '@primer/react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { Frame } from '../shared';

/** Where the code runs: an anonymous Jupyter server on prod1, a Jupyter server on this machine, or the browser's Pyodide. */
export type KernelTarget = 'jupyter' | 'local' | 'browser';

/** The kernels of this page, with what each is; prod1 first, the default. */
export const KERNEL_TARGETS: readonly {
  id: KernelTarget;
  label: string;
  hint: string;
  /** Shown, not chosen: the browser kernel is off for now. */
  disabled?: boolean;
}[] = [
  {
    id: 'jupyter',
    label: 'Jupyter (prod1)',
    hint: 'An anonymous Jupyter server on prod1.datalayer.run. Sandbox only — no agent, no account; no datalayer_cells there, so a run reads the values it names.',
  },
  {
    id: 'local',
    label: 'Jupyter (local)',
    hint: 'A Jupyter server on this machine, http://localhost:8888/api/jupyter-server (`make jupyter-server`), with datalayer_cells installed: Python reads and writes the sheet live.',
  },
  {
    id: 'browser',
    label: 'Browser',
    hint: 'Python in this page (Pyodide through JupyterLite). Off for now: Pyodide is slow to start.',
    disabled: true,
  },
];

/** Where the choice is kept between visits. */
export const KERNEL_TARGET_KEY = 'cells-examples-kernel';

/** The kept choice when it can be chosen, prod1 by default. */
export function readKernelTarget(): KernelTarget {
  try {
    const v = window.localStorage.getItem(KERNEL_TARGET_KEY);
    const kept = KERNEL_TARGETS.find((t) => t.id === v);
    return kept !== undefined && kept.disabled !== true ? kept.id : 'jupyter';
  } catch {
    return 'jupyter';
  }
}

/** The names of the kernel plugins, one per kernel; one is enabled at a time. */
export const KERNEL_PLUGIN: Record<KernelTarget, string> = {
  jupyter: '@datalayer/cells-examples-jupyter-prod1',
  local: '@datalayer/cells-examples-jupyter-local',
  browser: '@datalayer/cells-jupyter',
};

/** The kernel providers of the page, one per target. */
export type KernelProviders = Record<KernelTarget, KernelProvider>;

const PROD1_URL = 'https://prod1.datalayer.run/api/jupyter-server';
// An anonymous public sandbox (the one the jupyter-react examples use): no agent, no account.
const PROD1_TOKEN = '60c1661cc408f978c309d04157af55c9588ff9557c9380e4fb50785750703da6';
// The local server of `make jupyter-server`, as agent-runtimes' examples reach theirs: the same development token.
export const LOCAL_URL = 'http://localhost:8888/api/jupyter-server';
const LOCAL_TOKEN = PROD1_TOKEN;

/** The `./jupyter` entry, fetched once (it carries jupyter-react; JupyterLite and Pyodide come with the first run). */
const jupyter = () => {
  // JupyterLab's packages read webpack's public path at load; a bundler that is not webpack defines none.
  (globalThis as { __webpack_public_path__?: string }).__webpack_public_path__ ??= '';
  return import('@datalayer/cells/jupyter');
};

/** What the kernels are bound to (§3.13, C11-09): the page's model and its collaboration document, over the `datalayer.cells` comm. */
export interface PageBinding {
  readonly model: CellsModel;
  readonly doc: LoroDoc;
}

/** Bind a model to a collaboration document of its own (no room): what the kernel's `datalayer_cells` holds a copy of. */
export function bindDocument(model: CellsModel): PageBinding {
  const doc = new LoroDoc();
  new LoroBinding(model, doc, { peer: 'page' });
  return { model, doc };
}

/** The browser kernel: JupyterLite's Pyodide, the page as its server (an empty token). */
export function browserKernel(binding?: PageBinding): KernelProvider {
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
      return liteKernel({ binding }).connect();
    },
  };
}

/** A kernel on a Jupyter server: a `ServiceManager` on it, built on the first run. */
function serverKernel(
  id: string,
  label: string,
  url: string,
  token: string,
  binding?: PageBinding,
): KernelProvider {
  return {
    id,
    label,
    async connect() {
      const [{ serviceManagerKernel }, core, { ServiceManager }] = await Promise.all([
        jupyter(),
        import('@datalayer/jupyter-react/core'),
        import('@jupyterlab/services'),
      ]);
      core.setJupyterServerUrl(url);
      core.setJupyterServerToken(token);
      const serverSettings = core.createServerSettings(url, token);
      return serviceManagerKernel(new ServiceManager({ serverSettings }), {
        id,
        label,
        binding,
      }).connect();
    },
  };
}

/** The prod1 kernel: the anonymous server. */
export function prod1Kernel(binding?: PageBinding): KernelProvider {
  return serverKernel('prod1', 'Jupyter on prod1 (anonymous)', PROD1_URL, PROD1_TOKEN, binding);
}

/** The local kernel: the Jupyter server on this machine. */
export function localKernel(binding?: PageBinding): KernelProvider {
  return serverKernel('local', 'Jupyter on this machine', LOCAL_URL, LOCAL_TOKEN, binding);
}

/**
 * jupyter-react's `Output` and `Cell` as the code renderer, loaded on first
 * use (a double-click, a frame) through `./jupyter`, so the page holds
 * neither jupyter-react nor JupyterLite until a cell asks: the overlay shows
 * `Cell` from the first double-click, before any run, on whichever kernel.
 */
export function lazyCodeRenderer(): CodeRenderer {
  return {
    id: 'jupyter-lazy',
    output: lazy(() => jupyter().then((m) => ({ default: m.CodeOutput }))),
    editor: lazy(() => jupyter().then((m) => ({ default: m.CodeCellEditor }))),
    status: lazy(() => jupyter().then((m) => ({ default: m.KernelStatus }))),
  };
}

const LazyKernelStatus = lazy(() => jupyter().then((m) => ({ default: m.KernelStatus })));

/** The kernel's state beside the chooser: jupyter-react's indicator, in its no-kernel state until the runner connects one. */
function KernelBadge({ model }: { readonly model: CellsModel }) {
  return (
    <Suspense fallback={null}>
      <LazyKernelStatus model={model} />
    </Suspense>
  );
}

/** The name of the renderer plugin, always enabled. */
export const RENDERER_PLUGIN = '@datalayer/cells-examples-jupyter-renderer';

/** The kernel plugins, and the renderer's (jupyter-react's `Output` and `Cell`, lazily). */
export function kernelPlugins(
  providers: KernelProviders,
  renderer: CodeRenderer = lazyCodeRenderer(),
): PlatformInput[] {
  return [
    definePlugin({
      name: RENDERER_PLUGIN,
      displayName: 'jupyter-react renderer',
      description:
        "Outputs and the editor drawn by jupyter-react's Output and Cell, loaded on first use.",
      octicon: 'code',
      contributes: [contribution(CellsCodeRenderer, renderer, { id: renderer.id, order: 100 })],
    }),
    ...KERNEL_TARGETS.map((t) =>
      definePlugin({
        name: KERNEL_PLUGIN[t.id],
        displayName: `Kernel: ${t.label}`,
        description: t.hint,
        octicon: t.id === 'browser' ? 'browser' : 'server',
        contributes: [contribution(CellsKernels, providers[t.id], { id: providers[t.id].id })],
      }),
    ),
  ];
}

const SUM = `data = cells["B2:B7"]
rows = data.values.tolist() if hasattr(data, "values") else data
sum(r[0] for r in rows)`;

const TABLE = `data = cells["A1:B7"]
data["Double"] = data["Units"] * 2
data`;

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

/** The page's grid: a small table, a code cell summing it (C2), one plotting it beside the cells (C4); bound to its document, the kernels bound to it. */
export function codeCellsModel(providers?: KernelProviders, renderer?: CodeRenderer): CellsModel {
  // The document's binding comes after the model; the kernels, made on the first run, bind to it then.
  const later: { binding?: PageBinding } = {};
  const reactor = buildCellsReactor(
    kernelPlugins(
      providers ?? {
        jupyter: lazyProvider('prod1', 'Jupyter on prod1 (anonymous)', () =>
          prod1Kernel(later.binding),
        ),
        local: lazyProvider('local', 'Jupyter on this machine', () => localKernel(later.binding)),
        browser: lazyProvider('lite', 'Python in the browser (Pyodide)', () =>
          browserKernel(later.binding),
        ),
      },
      renderer,
    ),
  );
  const m = createCellsModel({
    reactor,
    data: fromRows([
      ['Month', 'Units', 'Total', 'Note'],
      ['Jan', 12, null, 'C2 sums B2:B7 in Python; D2 reads it as =C2*2'],
      ['Feb', 15],
      ['Mar', 19, null, 'C4 plots the table: hover it, or Alt+Down, for the figure'],
      ['Apr', 24],
      ['May', 28, null, 'C6 doubles the units: its table stays pinned beside the cells'],
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
    // The plot shows on hover and Alt+Down (frame: null); C6's table keeps a pinned frame beside the cells.
    code: codeCell(PLOT, { frame: null }),
  });
  m.dispatch({
    type: 'SET_CODE',
    sheet: 's1',
    row: 5,
    col: 2,
    code: codeCell(TABLE, { frame: { width: 380, height: 180 } }),
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
  later.binding = bindDocument(m);
  return m;
}

/** A kernel provider made on the first run, so it may bind to what exists then. */
function lazyProvider(id: string, label: string, make: () => KernelProvider): KernelProvider {
  return { id, label, connect: () => make().connect() };
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
  const table = model.code('s1', 5, 2);
  const state = (row: number) => model.codeState('s1', row, 2);
  const line = (name: string, c: typeof sum, s: ReturnType<typeof state>) =>
    `${name}: ${s === 'running' ? 'running' : c?.lastRun === undefined ? 'not run yet' : `run ${c.executionCount ?? ''} at ${new Date(c.lastRun).toLocaleTimeString()}${s === 'stale' ? ', stale' : ''}`}`;
  return (
    <p data-code-status="">
      {line('C2', sum, state(1))} · {line('C4', plot, state(3))} · {line('C6', table, state(5))}
    </p>
  );
}

/**
 * Code cells (§3.13): a cell holds Python; Shift+Enter runs it on a Jupyter
 * kernel, its result is a value the formulas read, and its rich outputs (a
 * figure) show in a frame beside the cells, drawn by jupyter-react's
 * `Output`. F4 opens the source in jupyter-react's `Cell`, on the same
 * kernel. The kernel is an anonymous Jupyter server on prod1 (the default),
 * a Jupyter server on this machine with `datalayer_cells` (the live sheet),
 * or the browser's Pyodide (off for now); the choice is kept between visits.
 */
export default function CodeCells(props: {
  readonly providers?: KernelProviders;
  /** A test's renderer in place of jupyter-react's lazy one. */
  readonly renderer?: CodeRenderer;
}) {
  const [model] = useState(() => codeCellsModel(props.providers, props.renderer));
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
        C2, C4 and C6 are code cells (the badge): click one and press Shift+Enter to run it, or
        double-click it to open its source in jupyter-react&apos;s <code>Cell</code>. C2&apos;s
        result lands in the grid, where D2 reads it; C4&apos;s figure shows when you hover the cell
        (or press Alt+Down on it), with a thumbnail of it in the cell; C6&apos;s table stays pinned
        beside the cells. Edit B2:B7 and the cells turn stale until they run again.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span id="kernel-label">Kernel:</span>
        <SegmentedControl aria-labelledby="kernel-label" size="small">
          {KERNEL_TARGETS.map((t) => (
            <SegmentedControl.Button
              key={t.id}
              selected={target === t.id}
              title={t.hint}
              disabled={t.disabled}
              aria-disabled={t.disabled}
              onClick={() => {
                if (t.disabled !== true) setTarget(t.id);
              }}
            >
              {t.label}
            </SegmentedControl.Button>
          ))}
        </SegmentedControl>
        <KernelBadge model={model} />
        <Button size="small" type="button" onClick={() => run('cells.code.runAll')}>
          Run all
        </Button>
        <Button size="small" type="button" onClick={() => run('cells.code.interrupt')}>
          Interrupt
        </Button>
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
