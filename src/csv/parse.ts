/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A streaming RFC 4180 parser: text arrives in pieces (a quoted field, a
 * CRLF or a BOM may be split across two), rows come out as they complete.
 * Quotes double inside quoted fields; CRLF, LF and CR all end a row; a BOM at
 * the very start is dropped. The delimiter is given, or sniffed from the
 * first rows (`,` `;` tab `|`: the one splitting them most consistently).
 *
 * @module csv/parse
 */

export type Delimiter = ',' | ';' | '\t' | '|';

const CANDIDATES: readonly Delimiter[] = [',', ';', '\t', '|'];

/**
 * The delimiter of a sample: for each candidate, the counts of fields per
 * line (outside quotes); the candidate with the most lines agreeing on a count
 * above 1 wins, ties to the earlier candidate. A comma when nothing splits.
 */
export function sniffDelimiter(sample: string): Delimiter {
  const lines: string[] = [];
  let line = '';
  let quoted = false;
  for (let i = 0; i < sample.length && lines.length < 20; i += 1) {
    const ch = sample[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (line !== '') lines.push(line);
      line = '';
    } else line += ch;
  }
  if (line !== '' && lines.length < 20) lines.push(line);
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = new Map<number, number>();
    for (const l of lines) {
      let n = 1;
      let q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (!q && ch === d) n += 1;
      }
      if (n > 1) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Rows out of text in pieces. */
export class CsvParser {
  #delimiter: Delimiter | undefined;
  #field = '';
  #row: string[] = [];
  #quoted = false;
  /** A quote seen inside a quoted field: a doubled quote, or its end, says the next character. */
  #quote = false;
  /** A CR ended the last row: an LF right after it belongs to the same line end. */
  #cr = false;
  #started = false;
  #pending = '';
  readonly #onRow: (row: string[]) => void;

  constructor(onRow: (row: string[]) => void, delimiter?: Delimiter) {
    this.#onRow = onRow;
    this.#delimiter = delimiter;
  }

  /** The delimiter used: given, or sniffed once enough text arrived. */
  get delimiter(): Delimiter | undefined {
    return this.#delimiter;
  }

  push(text: string): void {
    if (!this.#started) {
      this.#pending += text;
      // Sniff on the first 64 KiB (or the whole text, at the end).
      if (this.#pending.length < 65_536 && this.#delimiter === undefined) return;
      this.#begin();
      return;
    }
    this.#scan(text);
  }

  end(): void {
    if (!this.#started) this.#begin();
    if (this.#quote) {
      this.#quote = false;
      this.#quoted = false;
    }
    if (this.#field !== '' || this.#row.length > 0 || this.#quoted) this.#endRow();
  }

  #begin(): void {
    this.#started = true;
    let text = this.#pending;
    this.#pending = '';
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    this.#delimiter ??= sniffDelimiter(text);
    this.#scan(text);
  }

  #endRow(): void {
    this.#row.push(this.#field);
    this.#field = '';
    const row = this.#row;
    this.#row = [];
    this.#onRow(row);
  }

  #scan(text: string): void {
    const d = this.#delimiter!;
    let start = 0;
    let i = 0;
    const n = text.length;
    // Plain characters are taken in runs (slices), not one by one.
    const flush = (end: number) => {
      if (end > start) this.#field += text.slice(start, end);
    };
    while (i < n) {
      const ch = text[i];
      if (this.#cr) {
        this.#cr = false;
        if (ch === '\n') {
          i += 1;
          start = i;
          continue;
        }
      }
      if (this.#quoted) {
        if (this.#quote) {
          this.#quote = false;
          if (ch === '"') {
            // A doubled quote: one quote in the field.
            this.#field += '"';
            i += 1;
            start = i;
            continue;
          }
          // The quote closed the field; this character is read outside quotes.
          this.#quoted = false;
          start = i;
          continue;
        }
        if (ch === '"') {
          flush(i);
          this.#quote = true;
          i += 1;
          start = i;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === d) {
        flush(i);
        this.#row.push(this.#field);
        this.#field = '';
        i += 1;
        start = i;
      } else if (ch === '\n' || ch === '\r') {
        flush(i);
        this.#endRow();
        this.#cr = ch === '\r';
        i += 1;
        start = i;
      } else if (ch === '"' && i === start && this.#field === '') {
        this.#quoted = true;
        i += 1;
        start = i;
      } else {
        i += 1;
      }
    }
    flush(n);
  }
}

/** Every row of a whole text. */
export function parseCsvText(text: string, delimiter?: Delimiter): string[][] {
  const rows: string[][] = [];
  const parser = new CsvParser((r) => rows.push(r), delimiter);
  parser.push(text);
  parser.end();
  return rows;
}
