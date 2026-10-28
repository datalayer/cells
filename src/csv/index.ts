/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `@datalayer/cells/csv`: CSV and TSV in and out. Reading streams through an
 * RFC 4180 parser in a module worker and loads column chunks into a model;
 * writing gives a string or a stream. `CellsCsvPlugin` contributes both to
 * `datalayer.cells.importer` and `datalayer.cells.exporter`.
 *
 * @module csv
 */

import { contribution, definePlugin } from '@datalayer/reactor';
import { createCellsModel, type CellsModel } from '../core/model.js';
import type { CellsWorkbook } from '../core/format.js';
import { CellsExporters, CellsImporters } from '../points/index.js';
import { importCsv } from './read.js';
import { toCsv } from './write.js';

export { CsvParser, type Delimiter, parseCsvText, sniffDelimiter } from './parse.js';
export { type InferOptions, type Inferred, inferField } from './infer.js';
export { type CsvChunk, type CsvColumn, type CsvReadOptions, decodeChunk } from './chunks.js';
export { type CsvInput, type CsvOptions, type CsvSummary, importCsv, readCsv } from './read.js';
export { csvStream, type CsvWriteOptions, toCsv, usedZone } from './write.js';

/** The name of `CellsCsvPlugin`. */
export const CELLS_CSV_PLUGIN = '@datalayer/cells-csv';

/** The CSV importer and exporter, through `datalayer.cells.importer` and `.exporter`. */
export const CellsCsvPlugin = definePlugin({
  name: CELLS_CSV_PLUGIN,
  displayName: 'Cells CSV',
  description: 'CSV and TSV in and out.',
  octicon: 'file',
  contributes: [
    contribution(
      CellsImporters,
      {
        id: 'csv',
        mime: 'text/csv',
        extensions: ['.csv', '.tsv', '.txt'],
        // A one-sheet workbook of the file's values.
        read: async (input): Promise<CellsWorkbook> => {
          const model = createCellsModel();
          await importCsv(model, input as Blob | Uint8Array | string, { worker: false });
          return model.toJSON();
        },
      },
      { id: 'csv' },
    ),
    contribution(
      CellsExporters,
      {
        id: 'csv',
        mime: 'text/csv',
        extension: '.csv',
        write: async (model) => toCsv(model as CellsModel),
      },
      { id: 'csv' },
    ),
  ],
});
