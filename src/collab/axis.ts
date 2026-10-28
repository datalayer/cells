/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * An axis (the rows or the columns of a sheet) in a Loro document, as ids in
 * an order that concurrent edits cannot shift.
 *
 * Every index has an implicit id, `b` and the index in base 36, whose order
 * key is `1` and the index in five base-36 digits: nothing is stored for it.
 * So two peers writing a cell far beyond what either has touched write under
 * the same id, and no list grows by appending (appends from two peers would
 * merge as two runs, and every row after them would shift). Implicit ids go
 * on past the sheet's last row: a sheet that lost rows to deletes still has
 * rows at its end.
 *
 * Only what an edit changes is stored, in one `LoroMap` per axis, id to
 * entry: a row inserted gets an id of its peer (`p<peer>-<counter>`) and an
 * order key between its neighbours' keys; a row moved gets a new key; a row
 * deleted is marked deleted. Keys are fractional strings, compared as
 * strings, with a suffix of their peer and counter, so they are unique: there
 * is always a key between two others, and concurrent inserts at one place
 * keep both rows, in the same order on every peer.
 *
 * @module collab/axis
 */

import type { LoroMap } from 'loro-crdt';

/** What the map holds for an id an edit touched. */
export interface AxisEntry {
  /** The order key; absent for an implicit id that was only deleted. */
  readonly key?: string;
  readonly deleted?: true;
}

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
/** The width of an implicit key: 36⁵, sixty million rows, is past any sheet's end. */
const WIDTH = 5;

export const implicitId = (index: number): string => `b${index.toString(36)}`;

/**
 * The order key of an implicit index: `1` and the index in five base-36
 * digits. Keys starting with `0` sort below every implicit one, so there is
 * room for rows inserted above the first.
 */
export const implicitKey = (index: number): string => `1${index.toString(36).padStart(WIDTH, '0')}`;

/** The creation index of an implicit id, or `undefined` for an inserted one. */
export function implicitIndex(id: string): number | undefined {
  if (!/^b[0-9a-z]+$/.test(id)) return undefined;
  return parseInt(id.slice(1), 36);
}

/** How many implicit keys sort before a key. */
function implicitBefore(key: string): number {
  if (key[0] === '0') return 0;
  if (key[0] !== '1') return Number.MAX_SAFE_INTEGER;
  const head = key.slice(1, WIDTH + 1).padEnd(WIDTH, '0');
  // Every implicit key below the head sorts first; the head's own too when the key is longer.
  return parseInt(head, 36) + (key.length > WIDTH + 1 ? 1 : 0);
}

/**
 * A key strictly between `a` and `b` (`b` absent: no upper bound), and no
 * prefix of `b`, so anything appended to it stays below `b`.
 */
export function between(a: string, b: string | undefined): string {
  let prefix = '';
  for (let i = 0; ; i += 1) {
    const da = i < a.length ? DIGITS.indexOf(a[i]) : 0;
    const db = b !== undefined && i < b.length ? DIGITS.indexOf(b[i]) : DIGITS.length;
    if (da === db) {
      prefix += DIGITS[da];
      continue;
    }
    if (db - da > 1) return prefix + DIGITS[Math.floor((da + db) / 2)];
    // Adjacent digits: keep a's, and go above the rest of a with no bound.
    return prefix + DIGITS[da] + between(a.slice(i + 1), undefined);
  }
}

/** A key's suffix of its peer and counter: keys made by two peers, or twice by one, never meet. */
function suffix(peer: string, counter: number): string {
  const p = [...peer].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 36 ** 4, 7);
  return p.toString(36).padStart(4, '0') + counter.toString(36).padStart(6, '0');
}

/**
 * The live order of an axis: its ids by position. Implicit ids not touched
 * by an edit are not listed one by one: the order is a merge of the
 * untouched indexes (in index order) with the explicit entries (by key).
 */
export class AxisOrder {
  /** Explicit live entries, sorted by key. */
  readonly #explicit: { id: string; key: string }[];
  /** Implicit indexes an edit touched (moved or deleted): not in the untouched run. */
  readonly #touched: number[];
  /** The axis's length in the model, for listing. */
  readonly #count: number;

  constructor(entries: ReadonlyMap<string, AxisEntry>, count: number) {
    this.#count = count;
    const explicit: { id: string; key: string }[] = [];
    const touched: number[] = [];
    for (const [id, e] of entries) {
      const index = implicitIndex(id);
      if (index !== undefined) touched.push(index);
      if (!e.deleted && e.key !== undefined) explicit.push({ id, key: e.key });
    }
    explicit.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
    this.#explicit = explicit;
    this.#touched = touched.sort((a, b) => a - b);
  }

  /** Read an axis's entries from its map. */
  static of(map: LoroMap, count: number): AxisOrder {
    return new AxisOrder(new Map(Object.entries(map.toJSON() as Record<string, AxisEntry>)), count);
  }

  /** The axis's length in the model, implicit rows past the deleted ones included. */
  get length(): number {
    return this.#count;
  }

  /** Touched implicit indexes below an index. */
  #touchedBelow(index: number): number {
    let t = 0;
    for (const x of this.#touched) {
      if (x < index) t += 1;
      else break;
    }
    return t;
  }

  /** Untouched implicit indexes sorting before an explicit key. */
  #untouchedBefore(key: string): number {
    const n = implicitBefore(key);
    return n - this.#touchedBelow(n);
  }

  /** The untouched implicit index of a rank among the untouched ones. */
  #untouchedAt(rank: number): number {
    let i = rank;
    for (const x of this.#touched) {
      if (x <= i) i += 1;
      else break;
    }
    return i;
  }

  /** The id at a live position. */
  idAt(position: number): string | undefined {
    if (position < 0 || !Number.isInteger(position)) return undefined;
    for (let k = 0; k < this.#explicit.length; k += 1) {
      const e = this.#explicit[k];
      const before = this.#untouchedBefore(e.key) + k;
      if (position < before) return implicitId(this.#untouchedAt(position - k));
      if (position === before) return e.id;
    }
    return implicitId(this.#untouchedAt(position - this.#explicit.length));
  }

  /** The live position of an id, or `undefined` when it is deleted (or never was). */
  positionOf(id: string): number | undefined {
    const k = this.#explicit.findIndex((e) => e.id === id);
    if (k >= 0) return this.#untouchedBefore(this.#explicit[k].key) + k;
    const i = implicitIndex(id);
    if (i === undefined || this.#touched.includes(i)) return undefined;
    const key = implicitKey(i);
    let e = 0;
    while (e < this.#explicit.length && this.#explicit[e].key < key) e += 1;
    return i - this.#touchedBelow(i) + e;
  }

  /** Every live id within the axis's length, in order (for tests and small axes). */
  ids(): string[] {
    return Array.from({ length: this.#count }, (_, p) => this.idAt(p)!);
  }

  /** The order key at a live position. */
  keyAt(position: number): string {
    const id = this.idAt(position);
    if (id === undefined) throw new Error(`No row at ${position}.`);
    return this.#explicit.find((x) => x.id === id)?.key ?? implicitKey(implicitIndex(id)!);
  }
}

/** Keys for `n` ids between the live positions `at - 1` and `at`. */
function keysBefore(
  order: AxisOrder,
  at: number,
  n: number,
  peer: string,
  counter: { next: number },
) {
  let low = at === 0 ? '' : order.keyAt(at - 1);
  const high = order.keyAt(at);
  const keys: string[] = [];
  for (let k = 0; k < n; k += 1) {
    low = between(low, high) + suffix(peer, counter.next++);
    keys.push(low);
  }
  return keys;
}

/** Insert `n` ids before the live position `at`, under a peer. */
export function insert(
  map: LoroMap,
  count: number,
  at: number,
  n: number,
  peer: string,
  counter: { next: number },
): string[] {
  const order = AxisOrder.of(map, count);
  return keysBefore(order, at, n, peer, counter).map((key) => {
    const id = `p${peer}-${(counter.next++).toString(36)}`;
    map.set(id, { key });
    return id;
  });
}

/**
 * Move the ids at live positions `at` … `at + n - 1` before the live
 * position `to` (counted before the move): they get keys between the
 * neighbours of the place they go to.
 */
export function move(
  map: LoroMap,
  count: number,
  at: number,
  n: number,
  to: number,
  peer: string,
  counter: { next: number },
): string[] {
  const order = AxisOrder.of(map, count);
  const ids = Array.from({ length: n }, (_, k) => order.idAt(at + k)!);
  const keys = keysBefore(order, to, n, peer, counter);
  ids.forEach((id, k) => map.set(id, { key: keys[k] }));
  return ids;
}

/** Delete the ids at live positions `at` … `at + n - 1`. */
export function remove(map: LoroMap, count: number, at: number, n: number): string[] {
  const order = AxisOrder.of(map, count);
  const ids = Array.from({ length: n }, (_, k) => order.idAt(at + k)!);
  for (const id of ids) {
    const entry = map.get(id) as AxisEntry | undefined;
    map.set(id, { ...(entry ?? {}), deleted: true });
  }
  return ids;
}
