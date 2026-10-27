/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A bounded least-recently-used map: the text-measurement cache. Unbounded
 * caches grow with every string ever drawn; this one evicts the oldest entry
 * past its capacity, and counts hits for the debug overlay.
 *
 * @module render/lru
 */

export class Lru<K, V> {
  readonly capacity: number;
  #map = new Map<K, V>();
  hits = 0;
  misses = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error(`An LRU holds at least one entry; ${capacity} was asked for.`);
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const v = this.#map.get(key);
    if (v === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value as K);
  }

  get size(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }
}

/** The 2D context methods the renderer measures text with. */
export interface Measurer {
  font: string;
  measureText(text: string): { width: number };
}

/**
 * Text widths by font and string, bounded. 20,000 entries by default: under
 * 8 MB at the strings a sheet shows (§ budgets, text cache).
 */
export class TextMeasure {
  readonly cache: Lru<string, number>;

  constructor(capacity = 20_000) {
    this.cache = new Lru(capacity);
  }

  width(ctx: Measurer, font: string, text: string): number {
    const key = `${font}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (ctx.font !== font) ctx.font = font;
    const w = ctx.measureText(text).width;
    this.cache.set(key, w);
    return w;
  }

  /** Lines of `text` wrapped at word boundaries to fit `width` (a word longer than the width breaks). */
  wrap(ctx: Measurer, font: string, text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/(\s+)/)) {
        const next = line + word;
        if (line !== '' && this.width(ctx, font, next.trimEnd()) > width) {
          lines.push(line.trimEnd());
          line = word.trimStart();
        } else {
          line = next;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
}
