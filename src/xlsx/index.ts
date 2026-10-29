/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/xlsx`: XLSX in and out, over fflate, loaded lazily
 * (`await import('@datalayer/cells/xlsx')`) so the grid's bundle does not
 * carry it. `CellsXlsxPlugin` contributes the importer and the exporter to
 * `datalayer.cells.importer` and `datalayer.cells.exporter`.
 *
 * @module xlsx
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import type { CellsWorkbook } from '../core/format.js';
import type { CellsModel } from '../core/model.js';
import { CellsExporters, CellsImporters } from '../points/index.js';
import { readXlsxFile } from './readInWorker.js';
import { writeXlsx } from './write.js';

export { type ImportReport, readXlsx } from './read.js';
export { readXlsxFile, type XlsxReadOptions } from './readInWorker.js';
export { BUILTIN_FORMATS } from './formats.js';
export { writeXlsx } from './write.js';

/** The name of `CellsXlsxPlugin`. */
export const CELLS_XLSX_PLUGIN = '@datalayer/cells-xlsx';

/** The bytes of an input. */
async function bytesOf(
  input: ReadableStream<Uint8Array> | Uint8Array | string,
): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') throw new Error('An XLSX file is bytes, not text.');
  return new Uint8Array(await new Response(input).arrayBuffer());
}

/** The XLSX importer and exporter, loaded lazily on the first read of the importer point. */
export const CellsXlsxPlugin = definePlugin({
  name: CELLS_XLSX_PLUGIN,
  displayName: 'Cells XLSX',
  description: 'XLSX files in and out.',
  octicon: 'file',
  contributes: [
    contribution(
      CellsImporters,
      {
        id: 'xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extensions: ['.xlsx'],
        read: async (input): Promise<CellsWorkbook> =>
          (await readXlsxFile(await bytesOf(input))).workbook,
      },
      { id: 'xlsx' },
    ),
    contribution(
      CellsExporters,
      {
        id: 'xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: '.xlsx',
        write: async (model) => writeXlsx(model as CellsModel),
      },
      { id: 'xlsx' },
    ),
  ],
});
