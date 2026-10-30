/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The text-measurement cache, bounded. Unbounded caches grow with every string
 * ever drawn; this one forgets the strings not read for a while, and counts
 * hits for the debug overlay.
 *
 * @module render/lru
 */

/** The 2D context methods the renderer measures text with. */
export interface Measurer {
  font: string;
  measureText(text: string): { width: number };
}

/**
 * Text widths by font and string, bounded. 20,000 entries by default: under
 * 8 MB at the strings a sheet shows (§ budgets, text cache).
 *
 * Two generations of maps, by font then by text, stand in for a strict LRU: a
 * width read lands in the current generation; when that holds half the
 * capacity it becomes the previous one, and the previous one is dropped. A
 * width read within the last half-capacity reads is kept. No key is built per
 * read and no entry is moved on a hit, which a scroll does a few hundred
 * times a frame.
 */
export class TextMeasure {
  readonly capacity: number;
  #current = new Map<string, Map<string, number>>();
  #previous = new Map<string, Map<string, number>>();
  #currentSize = 0;
  #previousSize = 0;
  /** Hits, misses and size, for the debug overlay. */
  readonly cache = {
    hits: 0,
    misses: 0,
    size: 0,
  };

  constructor(capacity = 20_000) {
    if (!Number.isInteger(capacity) || capacity < 2)
      throw new Error(`A text cache holds at least two entries; ${capacity} was asked for.`);
    this.capacity = capacity;
  }

  width(ctx: Measurer, font: string, text: string): number {
    let inFont = this.#current.get(font);
    const cached = inFont?.get(text);
    if (cached !== undefined) {
      this.cache.hits += 1;
      return cached;
    }
    let w = this.#previous.get(font)?.get(text);
    if (w !== undefined) {
      this.cache.hits += 1;
    } else {
      this.cache.misses += 1;
      if (ctx.font !== font) ctx.font = font;
      w = ctx.measureText(text).width;
    }
    if (inFont === undefined) {
      inFont = new Map();
      this.#current.set(font, inFont);
    }
    inFont.set(text, w);
    this.#currentSize += 1;
    if (this.#currentSize >= this.capacity / 2) {
      this.#previous = this.#current;
      this.#previousSize = this.#currentSize;
      this.#current = new Map();
      this.#currentSize = 0;
    }
    this.cache.size = this.#currentSize + this.#previousSize;
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
