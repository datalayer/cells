/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import {
  CellsProvider,
  createCellsModel,
  type CellsModel,
  Spreadsheet,
  useCellsFromRows,
  useExport,
} from '@datalayer/cells';
import { importCsv, toCsv } from '@datalayer/cells/csv';
import { writeXlsx } from '@datalayer/cells/xlsx';
import { useState } from 'react';
import { Frame } from '../shared';
import { Button } from '@primer/react';

/** Give the browser bytes to save. */
function download(bytes: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cells.xlsx';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV in (a file picked, parsed in a worker) and out (the sheet as text). */
function Csv({ model, onReload }: { model: CellsModel; onReload: (model: CellsModel) => void }) {
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  return (
    <div>
      <p>
        <label>
          Open a CSV or TSV file{' '}
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file === undefined) return;
              const fresh = createCellsModel();
              setStatus(`Reading ${file.name}…`);
              const t0 = performance.now();
              const summary = await importCsv(fresh, file);
              setStatus(
                `${file.name}: ${summary.rows.toLocaleString()} rows of ${summary.cols}, separated by ${JSON.stringify(summary.delimiter)}, in ${Math.round(performance.now() - t0)} ms.`,
              );
              onReload(fresh);
            }}
          />
        </label>{' '}
        <Button size="small" onClick={() => setText(toCsv(model))}>
          Export the sheet as CSV
        </Button>
      </p>
      {status && <p role="status">{status}</p>}
      {text && <textarea aria-label="CSV" rows={6} cols={80} readOnly value={text} />}
    </div>
  );
}

function Json({ onReload }: { onReload: (model: CellsModel) => void }) {
  const { toJSON } = useExport();
  const [text, setText] = useState(() => JSON.stringify(toJSON(), null, 2));
  const [error, setError] = useState('');
  return (
    <div>
      <p>
        <Button size="small" onClick={() => setText(JSON.stringify(toJSON(), null, 2))}>
          Export as CellsWorkbook JSON
        </Button>
        <Button
          size="small"
          onClick={() => {
            try {
              onReload(createCellsModel({ data: JSON.parse(text) }));
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Load the JSON below
        </Button>
      </p>
      {error && <p role="alert">Refused: {error}</p>}
      <textarea
        aria-label="CellsWorkbook JSON"
        rows={14}
        cols={80}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

/**
 * Open a file: CSV or TSV (parsed in a worker), or XLSX (loaded on demand, read in its worker).
 * What the XLSX reader left out is listed under the grid.
 */
async function openFile(file: File): Promise<{ model: CellsModel; note: string }> {
  const t0 = performance.now();
  const took = () => `${Math.round(performance.now() - t0)} ms`;
  if (/\.xlsx$/i.test(file.name)) {
    // Loaded when a workbook is opened, so the grid's bundle does not carry it.
    const { readXlsxFile } = await import('@datalayer/cells/xlsx');
    const { workbook, report } = await readXlsxFile(new Uint8Array(await file.arrayBuffer()));
    const model = createCellsModel({ data: workbook });
    const skipped = report.skipped.map((x) => `${x.feature} (${x.count})`).join(', ');
    return {
      model,
      note:
        `${file.name}: ${report.sheets} sheets, ${report.cells.toLocaleString()} cells, ${report.formulas.toLocaleString()} formulas, in ${took()}.` +
        (skipped ? ` Not read yet: ${skipped}.` : ''),
    };
  }
  const model = createCellsModel();
  const summary = await importCsv(model, file);
  return {
    model,
    note: `${file.name}: ${summary.rows.toLocaleString()} rows of ${summary.cols}, separated by ${JSON.stringify(summary.delimiter)}, in ${took()}.`,
  };
}

/** XLSX, CSV and the native JSON. Edit the JSON to see a malformed file refused. */
export default function ImportExport() {
  const initial = useCellsFromRows([
    ['Region', 'Q1', 'Q2'],
    ['North', 120, 135],
    ['South', 98, 101],
  ]);
  const [state, setState] = useState<{ model: CellsModel; generation: number }>({
    model: initial,
    generation: 0,
  });
  const model = state.model;
  const [note, setNote] = useState('');
  return (
    <CellsProvider model={model}>
      <p>
        Drop a <code>.xlsx</code>, <code>.csv</code> or <code>.tsv</code> file on the grid, or pick
        one below.{' '}
        <Button size="small" onClick={() => download(writeXlsx(model))}>
          Download as XLSX
        </Button>
      </p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={async (e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file === undefined) return;
          setNote(`Reading ${file.name}…`);
          try {
            const opened = await openFile(file);
            setNote(opened.note);
            setState((s) => ({ model: opened.model, generation: s.generation + 1 }));
          } catch (error) {
            setNote(`${file.name} could not be opened: ${(error as Error).message}`);
          }
        }}
      >
        <Frame height={240}>
          <Spreadsheet key={state.generation} model={model} aria-label="Imported" />
        </Frame>
      </div>
      {note && <p role="status">{note}</p>}
      <Csv
        model={model}
        onReload={(m) => setState((s) => ({ model: m, generation: s.generation + 1 }))}
      />
      <Json
        key={state.generation}
        onReload={(m) => setState((s) => ({ model: m, generation: s.generation + 1 }))}
      />
    </CellsProvider>
  );
}
