/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The XLSX worker: the bytes of a file in (transferred), the workbook and its
 * import report out. Messages: `{ done: { workbook, report } }` or `{ error }`.
 *
 * @module xlsx/worker
 */

import { readXlsx } from './read.js';

interface Scope {
  onmessage: ((e: MessageEvent<{ bytes: Uint8Array }>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = globalThis as unknown as Scope;

scope.onmessage = (e) => {
  try {
    scope.postMessage({ done: readXlsx(e.data.bytes) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
