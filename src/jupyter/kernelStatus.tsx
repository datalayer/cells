/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The kernel indicator (§3.13): jupyter-react's `KernelIndicator` on the
 * runner's kernel connection, with a menu to interrupt or restart it, so the
 * kernel's state is seen while editing a cell (the overlay's header) and on
 * a page (beside a kernel chooser). Before the first connect it says *not
 * started*; after, idle, busy, starting, restarting, dead… as the kernel
 * says. Reached through jupyter-react's `kernel-indicator` entry, so a test
 * mounts it without the rest of jupyter-react.
 *
 * @module jupyter/kernelStatus
 */

import { KernelIndicator } from '@datalayer/jupyter-react/kernel-indicator';
import type { Kernel as JupyterKernel } from '@jupyterlab/services';
import { ActionList, ActionMenu } from '@primer/react';
import { useCallback, useSyncExternalStore } from 'react';
import { codeRunner } from '../core/codeRun.js';
import type { CellsModel } from '../core/model.js';
import type { CellsKernel } from '../points/index.js';
import { Themed } from './theme.js';

/** The props of `KernelStatus`. */
export interface KernelStatusProps {
  readonly model: CellsModel;
  /** The menu to interrupt and restart, beside the indicator; on by default. */
  readonly menu?: boolean;
}

/** The kernel connection a `CellsKernel` holds, when it is a jupyter-react one (`jupyterKernel`). */
export function connectionOf(
  kernel: CellsKernel | undefined,
): JupyterKernel.IKernelConnection | null {
  const held = (
    kernel as { kernel?: { connection?: JupyterKernel.IKernelConnection | null } } | undefined
  )?.kernel;
  return held?.connection ?? null;
}

/** The runner's kernel, followed: `undefined` before the first connect and after a reset. */
export function useRunnerKernel(model: CellsModel): CellsKernel | undefined {
  const runner = codeRunner(model);
  const subscribe = useCallback((notify: () => void) => runner.onKernel(notify), [runner]);
  return useSyncExternalStore(
    subscribe,
    () => runner.kernel(),
    () => runner.kernel(),
  );
}

/**
 * The kernel's state, as jupyter-react's `KernelIndicator` shows it on the
 * runner's kernel connection, with *Interrupt* and *Restart* in a menu;
 * *not started* before the first connect.
 */
export function KernelStatus({ model, menu = true }: KernelStatusProps) {
  const kernel = useRunnerKernel(model);
  const connection = connectionOf(kernel);
  return (
    <Themed>
      <span
        data-cells-kernel-status={kernel === undefined ? 'not-started' : 'connected'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {kernel === undefined ? (
          <span>Kernel: not started</span>
        ) : (
          <KernelIndicator kernel={connection} />
        )}
        {menu && kernel !== undefined && (
          <ActionMenu>
            <ActionMenu.Button size="small" variant="invisible" aria-label="Kernel actions">
              Kernel
            </ActionMenu.Button>
            <ActionMenu.Overlay width="small">
              <ActionList>
                <ActionList.Item
                  disabled={kernel.interrupt === undefined}
                  onSelect={() => void kernel.interrupt?.().catch(() => undefined)}
                >
                  Interrupt kernel
                </ActionList.Item>
                <ActionList.Item
                  disabled={kernel.restart === undefined}
                  onSelect={() => void kernel.restart?.().catch(() => undefined)}
                >
                  Restart kernel
                </ActionList.Item>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        )}
      </span>
    </Themed>
  );
}
