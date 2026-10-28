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
import type { IOutput } from '@jupyterlab/nbformat';
import type { ServiceManager } from '@jupyterlab/services';
import { useEffect, useId, useState } from 'react';
import { type CodeOutput as CodeOutputData, codeRef } from '../core/code.js';
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

/** Adapt a jupyter-react `Kernel` to the kernel code cells run on. */
export function jupyterKernel(kernel: Kernel): JupyterCellsKernel {
  return {
    kernel,
    async execute(code: string) {
      const executor = kernel.execute(code, { storeHistory: false });
      if (executor === undefined) throw new Error('The kernel is not connected.');
      await executor.done;
      return { outputs: executor.outputs as unknown as CodeOutputData[] };
    },
    interrupt: () => kernel.interrupt(),
  };
}

/** The options of `serviceManagerKernel` and `liteKernel`. */
export interface JupyterKernelOptions {
  readonly id?: string;
  readonly label?: string;
  /** The kernel spec to start; `python3` on a server, `python` in the browser. */
  readonly kernelName?: string;
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
      return jupyterKernel(kernel);
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
  );
}

/**
 * *Open in editor* (§3.13, C11-06): jupyter-react's `Cell` bound to a code
 * cell's source, on the sheet's own kernel (`startDefaultKernel={false}`, so
 * no second session starts; the kernel connects through the runner, as a
 * run does). *Save* writes the source back as one undo step.
 */
export function CodeCellEditor({ model: m, sheet, row, col, onClose }: CodeEditorRendererProps) {
  const model = m as CellsModel;
  const id = `cells-code-${useId()}`;
  const code = model.code(sheet, row, col);
  const [kernel, setKernel] = useState<Kernel | undefined>(undefined);
  useEffect(() => {
    let live = true;
    codeRunner(model)
      .connect()
      .then((k) => {
        if (live && 'kernel' in k) setKernel((k as JupyterCellsKernel).kernel);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [model]);
  if (code === undefined) return null;
  const save = () => {
    const source = cellsStore.getState().getSource(id) ?? code.source;
    if (source !== code.source)
      model.dispatch({ type: 'SET_CODE', sheet, row, col, code: { ...code, source } });
    onClose();
  };
  return (
    <div data-cells-code-editor="" role="dialog" aria-label={`Code of ${codeRef(row, col)}`}>
      <Cell
        id={id}
        source={code.source}
        outputs={code.outputs as unknown as IOutput[]}
        startDefaultKernel={false}
        autoStart={false}
        kernel={kernel}
        showToolbar={false}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button type="button" onClick={save}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
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
