/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The workbook's string pool: every string a cell holds, interned once and
 * reference-counted, so a column of repeated labels costs one string.
 *
 * @module core/strings
 */

export class StringPool {
  #strings: (string | undefined)[] = [];
  #counts = new Int32Array(64);
  #index = new Map<string, number>();
  #free: number[] = [];

  /** Take a reference to `text`; returns its index. */
  intern(text: string): number {
    let i = this.#index.get(text);
    if (i === undefined) {
      i = this.#free.pop() ?? this.#strings.length;
      this.#strings[i] = text;
      this.#index.set(text, i);
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
      this.#index.delete(text);
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
    return this.#index.size;
  }

  /** How many references the string at `index` has. */
  references(index: number): number {
    return this.#counts[index] ?? 0;
  }
}
