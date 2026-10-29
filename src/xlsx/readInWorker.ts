/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import type { CellsWorkbook } from '../core/format.js';
import { type ImportReport, readXlsx } from './read.js';

/** Where `readXlsxFile` reads: in a module worker (the default where the platform has one) or on this thread. */
export interface XlsxReadOptions {
  /** `false` reads on the calling thread; by default a module worker does when `Worker` exists. */
  readonly worker?: boolean;
}

/**
 * Read an XLSX file's bytes into a workbook and its import report: in a
 * module worker when the platform has one (a copy of the bytes is
 * transferred to it; the caller's stay as they are), else on this thread. A file the reader refuses
 * rejects with the reader's sentence.
 */
export async function readXlsxFile(
  bytes: Uint8Array,
  options: XlsxReadOptions = {},
): Promise<{ workbook: CellsWorkbook; report: ImportReport }> {
  if (options.worker === false || typeof Worker === 'undefined') return readXlsx(bytes);
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (
        e: MessageEvent<{
          done?: { workbook: CellsWorkbook; report: ImportReport };
          error?: string;
        }>,
      ) => {
        if (e.data.done !== undefined) resolve(e.data.done);
        else reject(new Error(e.data.error ?? 'The XLSX worker failed.'));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      const copy = bytes.slice();
      worker.postMessage({ bytes: copy }, [copy.buffer]);
    });
  } finally {
    worker.terminate();
  }
}
