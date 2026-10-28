/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Local history: a stack of steps, each the patches of one transaction.
 * Undo applies their inverses in reverse order; redo the patches again. No
 * snapshot of the workbook is ever stored. Capped at 500 steps or 64 MB of
 * patches, whichever comes first; the oldest steps go.
 *
 * @module core/history
 */

import type { Patch } from './patches.js';

export interface HistoryStep<S = unknown> {
  readonly label: string;
  readonly patches: readonly Patch[];
  readonly bytes: number;
  /** The selection before and after, restored with the step (view state, not undone itself). */
  readonly selectionBefore: S;
  readonly selectionAfter: S;
}

/** How much the local undo history keeps: a number of steps and a size of patches. */
export interface HistoryLimits {
  readonly steps: number;
  readonly bytes: number;
}

/** 500 steps or 64 MB of patches, whichever comes first. */
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { steps: 500, bytes: 64 * 1024 * 1024 };

export class LocalHistory<S = unknown> {
  readonly limits: HistoryLimits;
  #undo: HistoryStep<S>[] = [];
  #redo: HistoryStep<S>[] = [];
  #bytes = 0;

  constructor(limits: HistoryLimits = DEFAULT_HISTORY_LIMITS) {
    if (!(limits.steps >= 1) || !(limits.bytes >= 1))
      throw new Error('History limits must be positive.');
    this.limits = limits;
  }

  push(step: HistoryStep<S>): void {
    this.#undo.push(step);
    this.#bytes += step.bytes;
    for (const s of this.#redo) this.#bytes -= s.bytes;
    this.#redo = [];
    while (
      this.#undo.length > this.limits.steps ||
      (this.#bytes > this.limits.bytes && this.#undo.length > 1)
    ) {
      this.#bytes -= this.#undo.shift()!.bytes;
    }
  }

  /** The step to undo, moved to the redo stack; `undefined` when there is none. */
  popUndo(): HistoryStep<S> | undefined {
    const step = this.#undo.pop();
    if (step) this.#redo.push(step);
    return step;
  }

  popRedo(): HistoryStep<S> | undefined {
    const step = this.#redo.pop();
    if (step) this.#undo.push(step);
    return step;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get size(): { steps: number; bytes: number } {
    return { steps: this.#undo.length, bytes: this.#bytes };
  }

  /** The label of the step undo would undo. */
  get undoLabel(): string | undefined {
    return this.#undo.at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.#redo.at(-1)?.label;
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
    this.#bytes = 0;
  }
}
