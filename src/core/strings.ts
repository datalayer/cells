/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The workbook's string pool: every string a cell holds, interned once and
 * reference-counted, so a column of repeated labels costs one string.
 *
 * The index from text to slot is split over several maps by a cheap hash of
 * the text: a map rehashes all its entries in one call when it grows, which
 * at a million distinct strings blocked the page for some 60 ms in the middle
 * of a CSV import; each shard grows on its own, by a fraction of that.
 *
 * @module core/strings
 */

/** Index shards, a power of two. */
const SHARDS = 64;

/** The shard of a text: its length and a few of its characters, where texts of one column differ. */
function shardOf(text: string): number {
  const n = text.length;
  if (n === 0) return 0;
  const h =
    n * 31 +
    text.charCodeAt(n - 1) * 17 +
    (n > 1 ? text.charCodeAt(n - 2) * 7 : 0) +
    (n > 2 ? text.charCodeAt(n >> 1) * 3 : 0) +
    text.charCodeAt(0);
  return h & (SHARDS - 1);
}

export class StringPool {
  #strings: (string | undefined)[] = [];
  #counts = new Int32Array(64);
  readonly #index: Map<string, number>[] = Array.from({ length: SHARDS }, () => new Map());
  #size = 0;
  #free: number[] = [];

  /** Take a reference to `text`; returns its index. */
  intern(text: string): number {
    const shard = this.#index[shardOf(text)];
    let i = shard.get(text);
    if (i === undefined) {
      i = this.#free.pop() ?? this.#strings.length;
      this.#strings[i] = text;
      shard.set(text, i);
      this.#size += 1;
      if (i >= this.#counts.length) {
        const counts = new Int32Array(this.#counts.length * 2);
        counts.set(this.#counts);
        this.#counts = counts;
      }
    }
    this.#counts[i] += 1;
    return i;
  }

  /** Drop a reference; the string goes when the last one does. */
  release(index: number): void {
    const text = this.#strings[index];
    if (text === undefined || this.#counts[index] <= 0) {
      throw new Error(`The string pool holds nothing at ${index}: released twice?`);
    }
    this.#counts[index] -= 1;
    if (this.#counts[index] === 0) {
      this.#strings[index] = undefined;
      this.#index[shardOf(text)].delete(text);
      this.#size -= 1;
      this.#free.push(index);
    }
  }

  get(index: number): string {
    const text = this.#strings[index];
    if (text === undefined) throw new Error(`The string pool holds nothing at ${index}.`);
    return text;
  }

  /** How many distinct strings are held. */
  get size(): number {
    return this.#size;
  }

  /** How many references the string at `index` has. */
  references(index: number): number {
    return this.#counts[index] ?? 0;
  }
}
