/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * An axis (the rows or the columns of a sheet) in a Loro document, as ids in
 * an order that concurrent edits cannot shift.
 *
 * Every index of a new axis has an implicit id, `b` and its index at
 * creation in base 36, and its order key is that index: nothing is stored
 * for it. So two peers writing a cell far beyond what either has touched
 * write under the same id, and no list grows by appending (appends from two
 * peers would merge as two runs, and every row after them would shift).
 *
 * Only what an edit changes is stored, in one `LoroMap` per axis, id to
 * entry: a row inserted gets an id of its peer and an order key between its
 * neighbours' keys; a row moved gets a new key; a row deleted is marked
 * deleted. Order is by key, ties by id, so concurrent inserts at one place
 * keep both rows, in the same order on every peer.
 *
 * Keys are numbers: halving the gap at one place 50 times in a row exhausts
 * them; `insert` refuses then, rather than misorder.
 *
 * @module collab/axis
 */

import type { LoroMap } from 'loro-crdt';

/** What the map holds for an id an edit touched. */
export interface AxisEntry {
  /** The order key; absent for an implicit id that was only deleted. */
  readonly key?: number;
  readonly deleted?: true;
}

export const implicitId = (index: number): string => `b${index.toString(36)}`;

/** The creation index of an implicit id, or `undefined` for an inserted one. */
export function implicitIndex(id: string): number | undefined {
  if (!/^b[0-9a-z]+$/.test(id)) return undefined;
  return parseInt(id.slice(1), 36);
}

/**
 * The live order of an axis: its ids by position. Implicit ids not touched
 * by an edit are not listed one by one: the order is a merge of the
 * untouched indexes (in index order) with the explicit entries (by key).
 */
export class AxisOrder {
  /** Explicit live entries, sorted by key then id. */
  readonly #explicit: { id: string; key: number }[];
  /** Implicit indexes an edit touched (moved or deleted): not in the untouched run. */
  readonly #touched: number[];
  readonly #count: number;

  constructor(entries: ReadonlyMap<string, AxisEntry>, count: number) {
    this.#count = count;
    const explicit: { id: string; key: number }[] = [];
    const touched: number[] = [];
    for (const [id, e] of entries) {
      const index = implicitIndex(id);
      if (index !== undefined && index < count) touched.push(index);
      if (!e.deleted && e.key !== undefined) explicit.push({ id, key: e.key });
    }
    explicit.sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.#explicit = explicit;
    this.#touched = touched.sort((a, b) => a - b);
  }

  /** Read an axis's entries from its map. */
  static of(map: LoroMap, count: number): AxisOrder {
    return new AxisOrder(new Map(Object.entries(map.toJSON() as Record<string, AxisEntry>)), count);
  }

  /** Every live id, in order (an axis of a million rows lists a million ids: for tests and small axes). */
  ids(): string[] {
    const out: string[] = [];
    let e = 0;
    let t = 0;
    for (let i = 0; i < this.#count; i += 1) {
      while (e < this.#explicit.length && this.#explicit[e].key < i)
        out.push(this.#explicit[e++].id);
      if (t < this.#touched.length && this.#touched[t] === i) {
        t += 1;
        continue;
      }
      // An untouched implicit index sorts before an explicit entry of the same key with a larger id.
      while (
        e < this.#explicit.length &&
        this.#explicit[e].key === i &&
        this.#explicit[e].id < implicitId(i)
      )
        out.push(this.#explicit[e++].id);
      out.push(implicitId(i));
    }
    while (e < this.#explicit.length) out.push(this.#explicit[e++].id);
    return out;
  }

  /** The order key at a live position, for inserting next to it. */
  keyAt(position: number): number {
    const ids = this.ids();
    const id = ids[position];
    if (id === undefined) throw new Error(`No row at ${position}.`);
    return this.#explicit.find((x) => x.id === id)?.key ?? implicitIndex(id)!;
  }
}

/** Insert `n` ids before the live position `at` (at the end when `at` is the count), under a peer. */
export function insert(
  map: LoroMap,
  count: number,
  at: number,
  n: number,
  peer: string,
  counter: { next: number },
): string[] {
  const order = AxisOrder.of(map, count);
  const ids = order.ids();
  const before = at === 0 ? -1 : order.keyAt(at - 1);
  const after = at >= ids.length ? before + 1 + n : order.keyAt(at);
  const step = (after - before) / (n + 1);
  if (!(step > 0) || before + step === before || before + step * n >= after)
    throw new Error('No order key is left between these rows.');
  const out: string[] = [];
  for (let k = 1; k <= n; k += 1) {
    const id = `p${peer}.${(counter.next++).toString(36)}`;
    map.set(id, { key: before + step * k });
    out.push(id);
  }
  return out;
}

/** Delete the ids at live positions `at` … `at + n - 1`. */
export function remove(map: LoroMap, count: number, at: number, n: number): string[] {
  const ids = AxisOrder.of(map, count)
    .ids()
    .slice(at, at + n);
  for (const id of ids) {
    if (implicitIndex(id) !== undefined) map.set(id, { deleted: true });
    else map.set(id, { ...(map.get(id) as AxisEntry), deleted: true });
  }
  return ids;
}
