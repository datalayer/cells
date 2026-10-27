/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Reading CSV: from a `Blob` (a dropped file), bytes or text, decoded
 * (UTF-8 by default, any `TextDecoder` encoding), parsed in a module worker
 * where there is one (else here), and loaded into a model chunk by chunk,
 * yielding between chunks so the page keeps answering.
 *
 * @module csv/read
 */

import type { CellsModel } from '../core/model.js';
import { type CsvChunk, type CsvReadOptions, decodeChunk, parseToChunks } from './chunks.js';
import type { Delimiter } from './parse.js';

export type CsvInput = Blob | ArrayBuffer | Uint8Array | string;

export interface CsvOptions extends CsvReadOptions {
  /** A `TextDecoder` label: `utf-8` (the default), `windows-1252`, `utf-16le`… */
  readonly encoding?: string;
  /** `false`: parse on this thread even where workers exist (tests, Node). */
  readonly worker?: boolean;
}

/** The text of an input, in pieces. */
export async function* textPieces(input: CsvInput, encoding = 'utf-8'): AsyncGenerator<string> {
  if (typeof input === 'string') {
    yield input;
    return;
  }
  const decoder = new TextDecoder(encoding);
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    yield decoder.decode(input);
    return;
  }
  const reader = (input.stream() as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
  const rest = decoder.decode();
  if (rest !== '') yield rest;
}

/** What reading a file gave: its delimiter and size. */
export interface CsvSummary {
  readonly delimiter: Delimiter;
  readonly rows: number;
  readonly cols: number;
}

/**
 * Parse an input into chunks: in a module worker when the platform has one
 * (`options.worker` not `false`), else on this thread.
 */
export async function readCsv(
  input: CsvInput,
  options: CsvOptions,
  onChunk: (chunk: CsvChunk) => void | Promise<void>,
): Promise<CsvSummary> {
  if (options.worker === false || typeof Worker === 'undefined') {
    const chunks: CsvChunk[] = [];
    const summary = await parseToChunks(textPieces(input, options.encoding), options, (c) =>
      chunks.push(c),
    );
    for (const c of chunks) await onChunk(c);
    return summary;
  }
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise<CsvSummary>((resolve, reject) => {
      // Chunks are handled one at a time, in order, even when the handler is asynchronous.
      let queue = Promise.resolve();
      worker.onmessage = (
        e: MessageEvent<{ chunk?: CsvChunk; done?: CsvSummary; error?: string }>,
      ) => {
        const { chunk, done, error } = e.data;
        if (chunk !== undefined) queue = queue.then(() => onChunk(chunk));
        else if (done !== undefined) queue.then(() => resolve(done), reject);
        else reject(new Error(error ?? 'The CSV worker failed.'));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      const { worker: _, ...rest } = options;
      worker.postMessage({ input, options: rest });
    });
  } finally {
    worker.terminate();
  }
}

/**
 * A pause for the page between chunks, so rendering and input go first:
 * `scheduler.yield` where there is one, else a `MessageChannel` message
 * (`setTimeout` would be clamped to 4 ms once nested).
 */
function pause(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof s?.yield === 'function') return s.yield();
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Read a CSV file into a sheet of a model (the active one by default), from
 * its first cell; values only, typed as the options say. The previous
 * content of the cells written is replaced, and the undo history cleared, as
 * opening a file does.
 */
export async function importCsv(
  model: CellsModel,
  input: CsvInput,
  options: CsvOptions & { readonly sheet?: string } = {},
): Promise<CsvSummary> {
  const sheet = options.sheet ?? model.selection.sheet;
  return readCsv(input, options, async (chunk) => {
    const { columns, formats } = decodeChunk(chunk);
    model.loadColumns(sheet, { row: chunk.row, col: 0 }, columns, formats);
    await pause();
  });
}
