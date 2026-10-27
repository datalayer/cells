/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The CSV worker: a file (a `Blob`, bytes or text) in, column chunks out,
 * their buffers transferred. Messages: `{ chunk }` per chunk, then
 * `{ done: { delimiter, rows, cols } }`, or `{ error }`.
 *
 * @module csv/worker
 */

import { parseToChunks, transferables } from './chunks.js';
import { type CsvInput, textPieces } from './read.js';
import type { CsvReadOptions } from './chunks.js';

interface Scope {
  onmessage:
    | ((
        e: MessageEvent<{ input: CsvInput; options: CsvReadOptions & { encoding?: string } }>,
      ) => void)
    | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as Scope;

scope.onmessage = (e) => {
  const { input, options } = e.data;
  parseToChunks(textPieces(input, options.encoding), options, (chunk) =>
    scope.postMessage({ chunk }, transferables(chunk)),
  ).then(
    (done) => scope.postMessage({ done }),
    (error: unknown) =>
      scope.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
};
