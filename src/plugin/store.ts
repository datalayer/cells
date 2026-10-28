/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The workbooks a shell lists, and the one it shows. A workbook's model is
 * made the first time it is opened, on the shell's own Reactor platform, so
 * every plugin of the shell (a function, a command, a cell type) reaches every
 * grid; it stays made, so switching away and back keeps its state and history.
 *
 * @module plugin/store
 */

import type { ReactorPlatform } from '@datalayer/reactor';
import { useSyncExternalStore } from 'react';
import type { CellsWorkbook } from '../core/format.js';
import { type CellsModel, createCellsModel } from '../core/model.js';

/** A workbook in the catalog: what it is called, and what it holds until opened. */
export interface WorkbookEntry {
  readonly id: string;
  readonly title: string;
  /** Its content; none for an empty workbook. */
  readonly data?: CellsWorkbook;
}

interface Item {
  id: string;
  title: string;
  data?: CellsWorkbook;
  model?: CellsModel;
  /** Which registration put it here (`host`, or a plugin's contribution): removing one leaves the others. */
  source: string;
}

interface State {
  readonly workbooks: readonly { readonly id: string; readonly title: string }[];
  readonly open: string | null;
}

const items = new Map<string, Item>();
let open: string | null = null;
let state: State = { workbooks: [], open: null };
const listeners = new Set<() => void>();
let counter = 0;

function changed(): void {
  state = { workbooks: [...items.values()].map(({ id, title }) => ({ id, title })), open };
  for (const l of [...listeners]) l();
}

export function subscribeWorkbooks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkbooksState(): State {
  return state;
}

/** The catalog and the open workbook, re-rendering when they change. */
export function useWorkbooksState(): State {
  return useSyncExternalStore(subscribeWorkbooks, getWorkbooksState, getWorkbooksState);
}

/** Hand in workbooks; the returned function takes them back out (unless renamed or opened since, they go). */
export function registerWorkbooks(entries: readonly WorkbookEntry[], source = 'host'): () => void {
  for (const e of entries) {
    if (items.has(e.id)) throw new Error(`A workbook with id '${e.id}' is in the catalog already.`);
    items.set(e.id, { id: e.id, title: e.title, data: e.data, source });
  }
  changed();
  return () => {
    for (const e of entries) if (items.get(e.id)?.source === source) items.delete(e.id);
    if (open !== null && !items.has(open)) open = null;
    changed();
  };
}

/** A new empty workbook, opened; its id. */
export function createWorkbook(title?: string): string {
  let id: string;
  do id = `workbook-${++counter}`;
  while (items.has(id));
  items.set(id, { id, title: title ?? `Workbook ${counter}`, source: 'new' });
  open = id;
  changed();
  return id;
}

export function openWorkbook(id: string): void {
  if (!items.has(id)) throw new Error(`There is no workbook '${id}'.`);
  open = id;
  changed();
}

export function closeWorkbook(): void {
  open = null;
  changed();
}

export function renameWorkbook(id: string, title: string): void {
  const item = items.get(id);
  if (item === undefined) throw new Error(`There is no workbook '${id}'.`);
  if (title.trim() === '') throw new Error('A workbook needs a title.');
  item.title = title.trim();
  changed();
}

export function removeWorkbook(id: string): void {
  if (!items.delete(id)) throw new Error(`There is no workbook '${id}'.`);
  if (open === id) open = null;
  changed();
}

/** The model of a workbook, made on the platform the first time it is asked for. */
export function workbookModel(id: string, platform: ReactorPlatform): CellsModel {
  const item = items.get(id);
  if (item === undefined) throw new Error(`There is no workbook '${id}'.`);
  item.model ??= createCellsModel({ reactor: platform, ...(item.data ? { data: item.data } : {}) });
  return item.model;
}

/** Empty the catalog (tests, and a host replacing its content). */
export function resetWorkbooks(): void {
  items.clear();
  open = null;
  counter = 0;
  changed();
}
