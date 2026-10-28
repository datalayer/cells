/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The page's side of the `datalayer.cells` comm (§3.13, C11-09): opened on
 * the kernel a code cell runs on, it hands `datalayer_cells` there the
 * page's workbook and keeps the two in step. With loro-py in the kernel the
 * messages carry the collaboration document's snapshot and updates, as
 * Loro bytes, both ways; without it (the browser's Pyodide, where loro-py
 * cannot run) the page sends the workbook as JSON and applies the writes
 * the kernel sends back. Kept apart from the entry so a test reaches it
 * without jupyter-react.
 *
 * @module jupyter/comm
 */

import type { Kernel as JupyterKernel } from '@jupyterlab/services';
import type { CellsModel } from '../core/model.js';

/** What the page binds a kernel to (§3.13, C11-09): its model, and the collaboration document when it has one. */
export interface CellsBinding {
  readonly model: CellsModel;
  /** The `LoroDoc` a `LoroBinding` keeps in step with the model; without one, the comm carries the workbook as JSON. */
  readonly doc?: LoroDocLike;
}

/** The part of a `LoroDoc` the comm uses, typed here so this entry owes loro-crdt nothing. */
export interface LoroDocLike {
  export(options: { mode: 'snapshot' }): Uint8Array;
  import(bytes: Uint8Array): unknown;
  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void;
}

const b64 = (bytes: Uint8Array) => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** An open `datalayer.cells` comm: how to stop it, and what the kernel said it holds. */
export interface CellsComm {
  /**
   * What the kernel holds, once its `datalayer_cells` answers. Rejected when
   * the kernel closes the comm (no `datalayer_cells` there: a Jupyter kernel
   * closes a comm whose target it does not know) or does not answer within
   * `COMM_READY_MS`: the runs then send their values, as before C11-09.
   */
  readonly mode: Promise<'loro' | 'json'>;
  close(): void;
}

/**
 * Open the `datalayer.cells` comm on a kernel connection: the kernel's
 * `datalayer_cells` answers `ready` with its mode; then the page sends the
 * document (a Loro snapshot, or the workbook as JSON) and every later
 * update, and takes the kernel's updates (Loro bytes merged into the
 * document) or writes (`SET_CELLS`, labelled with the cell that wrote).
 */
/** How long a kernel has to answer the comm before the runs go on without the live workbook. */
export const COMM_READY_MS = 5000;

export function openCellsComm(
  connection: JupyterKernel.IKernelConnection,
  binding: CellsBinding,
): CellsComm {
  const { model, doc } = binding;
  const comm = connection.createComm('datalayer.cells');
  let mode: 'loro' | 'json' | undefined;
  let resolveMode: (m: 'loro' | 'json') => void = () => undefined;
  let rejectMode: (error: Error) => void = () => undefined;
  const modePromise = new Promise<'loro' | 'json'>((resolve, reject) => {
    resolveMode = resolve;
    rejectMode = reject;
  });
  // Handled here too: a run that never asks is no unhandled rejection.
  modePromise.catch(() => undefined);
  const unanswered = setTimeout(
    () => rejectMode(new Error('The kernel has no datalayer_cells: the runs send their values.')),
    COMM_READY_MS,
  );
  void modePromise.then(
    () => clearTimeout(unanswered),
    () => clearTimeout(unanswered),
  );
  comm.onClose = () => {
    rejectMode(new Error('The kernel closed the datalayer.cells comm: no datalayer_cells there.'));
  };
  const stops: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendJson = () => {
    timer = undefined;
    comm.send({ type: 'workbook', workbook: model.toJSON() } as never);
  };
  comm.onMsg = (msg) => {
    const data = msg.content.data as {
      type?: string;
      mode?: string;
      data?: string;
      sheet?: string;
      origin?: string;
      cells?: unknown;
    };
    if (data.type === 'ready') {
      mode = data.mode === 'loro' && doc !== undefined ? 'loro' : 'json';
      resolveMode(mode);
      if (mode === 'loro' && doc !== undefined) {
        comm.send({ type: 'snapshot', data: b64(doc.export({ mode: 'snapshot' })) } as never);
        stops.push(
          doc.subscribeLocalUpdates((bytes) => {
            comm.send({ type: 'update', data: b64(bytes) } as never);
          }),
        );
      } else {
        comm.send({ type: 'snapshot', workbook: model.toJSON() } as never);
        stops.push(
          model.subscribe((tx) => {
            if (tx.label.startsWith('Code:')) return;
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(sendJson, 100);
          }),
        );
      }
      return;
    }
    if (
      data.type === 'update' &&
      mode === 'loro' &&
      doc !== undefined &&
      typeof data.data === 'string'
    ) {
      doc.import(unb64(data.data));
      return;
    }
    if (data.type === 'write' && mode === 'json' && Array.isArray(data.cells)) {
      const sheet = typeof data.sheet === 'string' ? data.sheet : model.selection.sheet;
      const origin = typeof data.origin === 'string' ? data.origin : 'python';
      model.transact(`Code: ${origin}`, () => {
        for (const entry of data.cells as unknown[]) {
          if (!Array.isArray(entry) || entry.length < 3) continue;
          const [row, col, value] = entry as [number, number, unknown];
          model.dispatch({
            type: 'SET_CELLS',
            sheet,
            at: { row, col },
            cells: [[value as never]],
          });
        }
      });
    }
  };
  void comm.open({ mode: doc !== undefined ? 'loro' : 'json' } as never);
  return {
    mode: modePromise,
    close: () => {
      for (const stop of stops) stop();
      if (timer !== undefined) clearTimeout(timer);
      void comm.close();
    },
  };
}
