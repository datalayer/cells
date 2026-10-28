/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/jupyter` (§3.13): code cells on Jupyter, through
 * `@datalayer/jupyter-react`. The only entry that imports jupyter-react (an
 * optional peer), so the grid's bundle never carries it: a host imports this
 * entry, lazily, when it wants code cells to run and their outputs drawn.
 *
 * - `CellsJupyterPlugin(provider?)`: a Reactor plugin contributing a kernel
 *   to `datalayer.cells.kernel` (`liteKernel()`, the browser's Pyodide
 *   through JupyterLite, by default; `serviceManagerKernel(manager)` for a
 *   Jupyter server or a Datalayer runtime) and jupyter-react's `Output` and
 *   `Cell` to `datalayer.cells.codeRenderer`.
 * - `CodeOutput`: a code cell's stored outputs, rendered statically by
 *   jupyter-react's `Output` (no kernel: scrolling never re-runs anything).
 * - `CodeCellEditor`: *Open in editor*, jupyter-react's `Cell` bound to a
 *   code cell's source, on the sheet's kernel (`startDefaultKernel={false}`).
 * - `KernelStatus`: jupyter-react's `KernelIndicator` on the runner's kernel,
 *   with *Interrupt* and *Restart*; the overlay's header shows it.
 * - `openCellsComm`: the `datalayer.cells` comm (§3.13, C11-09) the page opens
 *   on the kernel it runs code on, so `datalayer_cells` there holds the
 *   page's workbook: the collaboration document's snapshot and updates, as
 *   Loro bytes, both ways (with loro-py), or the workbook as JSON and the
 *   kernel's writes back (the browser's Pyodide, where loro-py cannot run).
 *
 * @module jupyter
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import {
  Cell,
  cellsStore,
  createLiteServiceManager,
  jupyterReactStore,
  Kernel,
  Output,
  ServiceManagerLess,
} from '@datalayer/jupyter-react';
import { Button } from '@primer/react';
import type { IOutput } from '@jupyterlab/nbformat';
import type { ServiceManager } from '@jupyterlab/services';
import { useEffect, useId, useState } from 'react';
import { type CodeOutput as CodeOutputData, codeRef } from '../core/code.js';
import { Themed } from './theme.js';
import { CODE_EDITOR_MIN_WIDTH, PlainEditor, safeOutputs } from '../react/CodeLayer.js';
import { type CellsBinding, type CellsComm, openCellsComm } from './comm.js';

export { type CellsBinding, type CellsComm, type LoroDocLike, openCellsComm } from './comm.js';
export { Themed, useHostColorMode } from './theme.js';
export {
  connectionOf,
  KernelStatus,
  type KernelStatusProps,
  useRunnerKernel,
} from './kernelStatus.js';
import { codeRunner } from '../core/codeRun.js';
import type { CellsModel } from '../core/model.js';
import {
  type CellsKernel,
  CellsCodeRenderer,
  CellsKernels,
  type CodeEditorRendererProps,
  type CodeOutputRendererProps,
  type KernelProvider,
} from '../points/index.js';

/** The name of `CellsJupyterPlugin`. */
export const CELLS_JUPYTER_PLUGIN = '@datalayer/cells-jupyter';

/** A `CellsKernel` over a jupyter-react `Kernel`, which it keeps for the editor. */
export interface JupyterCellsKernel extends CellsKernel {
  /** The jupyter-react kernel itself: `CodeCellEditor` hands it to `Cell`. */
  readonly kernel: Kernel;
}

/** Adapt a jupyter-react `Kernel` to the kernel code cells run on; with a `binding`, the page's workbook is bound to it over the comm. */
export function jupyterKernel(kernel: Kernel, binding?: CellsBinding): JupyterCellsKernel {
  let comm: CellsComm | undefined;
  const bound = async () => {
    if (binding === undefined || comm !== undefined) return;
    await kernel.ready;
    const connection = kernel.connection;
    if (connection === null) throw new Error('The kernel is not connected.');
    comm = openCellsComm(connection, binding);
    await comm.mode;
  };
  return {
    kernel,
    async execute(code: string) {
      await bound();
      const executor = kernel.execute(code, { storeHistory: false });
      if (executor === undefined) throw new Error('The kernel is not connected.');
      await executor.done;
      return { outputs: executor.outputs as unknown as CodeOutputData[] };
    },
    interrupt: () => kernel.interrupt(),
    restart: () => kernel.restart(),
    onStatus: (listener) => {
      const connection = kernel.connection;
      if (connection === null) return () => undefined;
      const on = (_c: unknown, status: string) => listener(status);
      connection.statusChanged.connect(on);
      listener(connection.status);
      return () => {
        connection.statusChanged.disconnect(on);
      };
    },
  };
}

/** The options of `serviceManagerKernel` and `liteKernel`. */
export interface JupyterKernelOptions {
  readonly id?: string;
  readonly label?: string;
  /** The kernel spec to start; `python3` on a server, `python` in the browser. */
  readonly kernelName?: string;
  /** The page's workbook, bound to the kernel over the `datalayer.cells` comm on the first run. */
  readonly binding?: CellsBinding;
}

/** Publish a service manager to jupyter-react's store, so its components (an `Output` with no kernel) adopt it instead of building one. */
function publish(manager: ServiceManager.IManager): void {
  if (jupyterReactStore.getState().serviceManager !== manager)
    jupyterReactStore.getState().setServiceManager(manager);
}

/** A kernel of a service manager (a Jupyter server, a Datalayer runtime), started on the first run. */
export function serviceManagerKernel(
  serviceManager: ServiceManager.IManager | (() => Promise<ServiceManager.IManager>),
  options: JupyterKernelOptions = {},
): KernelProvider {
  const kernelName = options.kernelName ?? 'python3';
  return {
    id: options.id ?? 'jupyter',
    label: options.label ?? `Jupyter (${kernelName})`,
    async connect() {
      const manager =
        typeof serviceManager === 'function' ? await serviceManager() : serviceManager;
      await manager.ready;
      publish(manager);
      const kernel = new Kernel({
        kernelName,
        kernelSpecName: kernelName,
        kernelManager: manager.kernels,
        kernelspecsManager: manager.kernelspecs,
        sessionManager: manager.sessions,
      });
      await kernel.ready;
      return jupyterKernel(kernel, options.binding);
    },
  };
}

let lite: Promise<ServiceManager.IManager> | undefined;

/** The browser's JupyterLite service manager, made once (Pyodide is megabytes: it loads on the first run). */
export function liteServiceManager(): Promise<ServiceManager.IManager> {
  lite ??= createLiteServiceManager(true).catch((error: unknown) => {
    lite = undefined;
    throw error;
  });
  return lite;
}

/** The browser's Python (Pyodide through JupyterLite): no server, no account. Loaded on the first run. */
export function liteKernel(options: JupyterKernelOptions = {}): KernelProvider {
  return serviceManagerKernel(liteServiceManager, {
    id: options.id ?? 'lite',
    label: options.label ?? 'Python in the browser (Pyodide)',
    kernelName: options.kernelName ?? 'python',
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
  });
}

/**
 * A code cell's outputs, rendered by jupyter-react's `Output` from what the
 * model stores, with no kernel (remounting never re-runs). A `ServiceManagerLess`
 * is published for it when nothing was: an `Output` with no manager would
 * build one against a Jupyter server nobody asked for.
 */
export function CodeOutput({ outputs, cell, width, height }: CodeOutputRendererProps) {
  const [ready, setReady] = useState(jupyterReactStore.getState().serviceManager !== undefined);
  useEffect(() => {
    if (jupyterReactStore.getState().serviceManager === undefined)
      publish(new ServiceManagerLess() as unknown as ServiceManager.IManager);
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <Themed>
      <div data-cells-jupyter-output={cell} style={{ width, height, overflow: 'auto' }}>
        <Output
          id={`cells-output-${cell}`}
          outputs={outputs as unknown as IOutput[]}
          showEditor={false}
          showControl={false}
          showKernelProgressBar={false}
          autoRun={false}
          disableRun
          toolbarPosition="none"
        />
      </div>
    </Themed>
  );
}

/** How long a kernel may take to connect before the overlay says so and goes on without it, ms. */
export const KERNEL_CONNECT_TIMEOUT_MS = 20_000;

/** The kernel as the editor sees it: connecting, connected (jupyter-react's `Cell` mounts), or failed (the error shown, the plain editor stays). */
export type EditorKernelState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly kernel: Kernel }
  | { readonly kind: 'failed'; readonly message: string };

/** The runner's kernel for the editor: connected now, connecting, or failed (an error, or {@link KERNEL_CONNECT_TIMEOUT_MS} gone by). */
export function useEditorKernel(model: CellsModel): EditorKernelState {
  const runner = codeRunner(model);
  const held = runner.kernel();
  const [state, setState] = useState<EditorKernelState>(() =>
    held !== undefined && 'kernel' in held
      ? { kind: 'connected', kernel: (held as JupyterCellsKernel).kernel }
      : { kind: 'connecting' },
  );
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      if (live)
        setState((s) =>
          s.kind === 'connecting'
            ? {
                kind: 'failed',
                message: `The kernel is not connected after ${KERNEL_CONNECT_TIMEOUT_MS / 1000} s (the browser kernel downloads Pyodide on its first run); the cell can be edited meanwhile.`,
              }
            : s,
        );
    }, KERNEL_CONNECT_TIMEOUT_MS);
    runner
      .connect()
      .then((k) => {
        if (!live) return;
        if ('kernel' in k)
          setState({ kind: 'connected', kernel: (k as JupyterCellsKernel).kernel });
        else
          setState({
            kind: 'failed',
            message: 'The kernel is not a Jupyter kernel: the cell is edited here and run on it.',
          });
      })
      .catch((error: Error) => {
        if (live) setState({ kind: 'failed', message: error.message });
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runner]);
  return state;
}

/**
 * *Open in editor* (§3.13, C11-06): jupyter-react's `Cell` bound to a code
 * cell's source, on the sheet's own kernel (`startDefaultKernel={false}`, so
 * no second session starts; the kernel connects through the runner, as a
 * run does). `Cell` needs a connected kernel to mount (it waits for the
 * kernel's `ready` before building its editor), so while the kernel
 * connects, and when it fails or takes over 20 s (said in a line), the plain
 * editor stands in: never a spinner with no editor. The cell's last outputs
 * show under the editor, statically. *Save* writes the source back as one
 * undo step.
 */
export function CodeCellEditor({
  model: m,
  sheet,
  row,
  col,
  onClose,
  register,
}: CodeEditorRendererProps) {
  const model = m as CellsModel;
  const id = `cells-code-${useId()}`;
  const code = model.code(sheet, row, col);
  const kernel = useEditorKernel(model);
  const write = () => {
    const current = model.code(sheet, row, col);
    const source = cellsStore.getState().getSource(id);
    if (current !== undefined && source !== undefined && source !== current.source)
      model.dispatch({ type: 'SET_CODE', sheet, row, col, code: { ...current, source } });
  };
  if (kernel.kind === 'connected') register?.({ save: write });
  if (code === undefined) return null;
  const save = () => {
    write();
    onClose();
  };
  const ref = codeRef(row, col);
  const outputs = code.outputs.length > 0 && (
    <div data-cells-code-editor-outputs="" style={{ marginTop: 8 }}>
      <CodeOutput
        outputs={model.codeTrusted(sheet, row, col) ? code.outputs : safeOutputs(code.outputs)}
        trusted={model.codeTrusted(sheet, row, col)}
        cell={ref}
        width={CODE_EDITOR_MIN_WIDTH - 16}
        height={200}
      />
    </div>
  );
  if (kernel.kind !== 'connected') {
    // The plain editor until the kernel is there (or instead of it): editable at once, saved the same way.
    return (
      <Themed>
        <div data-cells-code-editor-waiting={kernel.kind}>
          <p
            style={{ margin: '0 0 6px', fontSize: 12 }}
            data-cells-code-editor-kernel={kernel.kind}
          >
            {kernel.kind === 'connecting' ? 'Connecting the kernel…' : kernel.message}
          </p>
          <PlainEditor
            model={model}
            sheet={sheet}
            row={row}
            col={col}
            onClose={onClose}
            register={register}
          />
          {outputs}
        </div>
      </Themed>
    );
  }
  return (
    <Themed>
      <div data-cells-code-editor="" role="dialog" aria-label={`Code of ${ref}`}>
        <Cell
          id={id}
          source={code.source}
          outputs={code.outputs as unknown as IOutput[]}
          startDefaultKernel={false}
          autoStart={false}
          kernel={kernel.kernel}
          showToolbar={false}
        />
        {outputs}
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <Button size="small" variant="primary" onClick={save}>
            Save
          </Button>
          <Button size="small" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Themed>
  );
}

/**
 * The plugin: a kernel (the browser's Pyodide by default) to
 * `datalayer.cells.kernel`, and jupyter-react's `Output` and `Cell` to
 * `datalayer.cells.codeRenderer`.
 */
export function CellsJupyterPlugin(provider: KernelProvider = liteKernel()) {
  return definePlugin({
    name: CELLS_JUPYTER_PLUGIN,
    displayName: 'Jupyter',
    description: `Code cells run on ${provider.label}, their outputs and editor drawn by jupyter-react.`,
    octicon: 'code',
    contributes: [
      contribution(CellsKernels, provider, { id: provider.id }),
      contribution(
        CellsCodeRenderer,
        { id: 'jupyter', output: CodeOutput, editor: CodeCellEditor },
        { id: 'jupyter', order: 100 },
      ),
    ],
  });
}
