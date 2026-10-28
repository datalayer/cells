/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The build-time check of a site's cells files.
 *
 * It runs in Node, where the headless core runs too, so a `.cells.json` file
 * is checked whole by the same `validateWorkbook` the grid loads it with
 * (the path of the first bad field in the sentence), and a `.csv` file is
 * parsed by the same parser. A file that fails here fails the build: a page
 * whose sheet cannot be shown is a bug, not a warning. The grid's modules are
 * handed in (`CellsModules`): the plugin loads them in a worker thread, with
 * Node's own ES-module loader (see `worker.ts`), and the tests pass theirs.
 */

/** What the check reads the files with: the grid's loader and its CSV parser. */
export type CellsModules = {
  validateWorkbook: (data: unknown) => unknown;
  parseCsvText: (text: string) => string[][];
};

/** One thing wrong with a cells file, where it is. */
export type CellsFileProblem = {
  /** The file, as the caller named it. */
  file: string;
  /** Where in the file: the path `validateWorkbook` names (`sheets[0].rows["12"].cells["3"].s`), `row 4`, or `file`. */
  where: string;
  message: string;
};

export type CellsFileCheck = {
  /** The most cells a workbook or CSV file may hold; no limit when absent. */
  maxCells?: number;
};

/** What a checked file holds: its sheets and cells, for the build's count. */
export type CellsFileSummary = {
  sheets: number;
  cells: number;
};

/** The kind of a cells file by its name, or `undefined` for a file the plugin does not read. */
export const fileKind = (file: string): 'workbook' | 'csv' | undefined =>
  file.endsWith('.cells.json') ? 'workbook' : /\.(csv|tsv)$/i.test(file) ? 'csv' : undefined;

/** What is wrong with one file's text; the summary when it is fine. */
export const checkCellsFile = (
  file: string,
  text: string,
  { validateWorkbook, parseCsvText }: CellsModules,
  { maxCells }: CellsFileCheck = {},
): { problems: CellsFileProblem[]; summary?: CellsFileSummary } => {
  const problems: CellsFileProblem[] = [];
  const problem = (where: string, message: string) => problems.push({ file, where, message });
  const kind = fileKind(file);
  if (kind === undefined) {
    problem('file', 'a cells file is a .cells.json workbook or a .csv file');
    return { problems };
  }
  if (kind === 'csv') {
    const rows = parseCsvText(text);
    const cells = rows.reduce((n, row) => n + row.filter((field) => field !== '').length, 0);
    if (cells === 0) problem('file', 'the CSV file holds no value');
    const widths = new Set(rows.map((row) => row.length));
    if (widths.size > 1) {
      const first = rows[0].length;
      const odd = rows.findIndex((row) => row.length !== first);
      problem(`row ${odd + 1}`, `${rows[odd].length} fields, where the first row has ${first}`);
    }
    if (maxCells !== undefined && cells > maxCells)
      problem('file', `${cells} cells, more than the ${maxCells} this site allows`);
    return { problems, summary: { sheets: 1, cells } };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    problem('file', `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { problems };
  }
  try {
    validateWorkbook(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The loader's sentence starts with the path of the bad field: `sheets[0].name: …`.
    const colon = message.indexOf(': ');
    if (colon > 0 && !message.slice(0, colon).includes(' '))
      problem(message.slice(0, colon), message.slice(colon + 2));
    else problem('file', message);
    return { problems };
  }
  const workbook = data as {
    sheets: { rows: Record<string, { cells: Record<string, unknown> }> }[];
  };
  let cells = 0;
  for (const sheet of workbook.sheets)
    for (const row of Object.values(sheet.rows)) cells += Object.keys(row.cells).length;
  if (maxCells !== undefined && cells > maxCells)
    problem('file', `${cells} cells, more than the ${maxCells} this site allows`);
  return { problems, summary: { sheets: workbook.sheets.length, cells } };
};

/** The problems as the build prints them, one per line. */
export const describeProblems = (problems: readonly CellsFileProblem[]): string =>
  problems.map(({ file, where, message }) => `${file} (${where}): ${message}`).join('\n');
