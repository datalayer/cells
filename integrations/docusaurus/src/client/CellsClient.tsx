/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The sheet itself, in the browser: the grid's `<Spreadsheet>` under a
 * Primer theme, from a workbook the page imported or a file the site serves
 * (a `.cells.json` validated by the grid's loader, a `.csv` parsed by its
 * parser), in the site's colour mode.
 *
 * It imports nothing of Docusaurus: the colour mode is read from the
 * `data-theme` Docusaurus keeps on `<html>`, so this module works whichever
 * copy of Docusaurus' packages a workspace resolves next to it.
 */

import type { JSX } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BaseStyles, ThemeProvider } from '@primer/react';
import {
  type CellsWorkbook,
  type CellValue,
  createCellsModel,
  type CellsModel,
  fromRows,
  parseInput,
  Spreadsheet,
  validateWorkbook,
} from '@datalayer/cells';
import { parseCsvText } from '@datalayer/cells/csv';

export type CellsClientProps = {
  data?: unknown;
  src?: string;
  height: number;
  /** The primer-addons theme variant the sheet wears. */
  theme: string;
  editable: boolean;
  label?: string;
};

/** The site's colour mode, as Docusaurus marks it on `<html>`. */
const siteColorMode = (): 'light' | 'dark' =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

const watchColorMode = (changed: () => void): (() => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
};

/** A workbook from a file's text: `.csv` parsed with each field typed as typed, else the JSON validated. */
export const workbookOf = (name: string, text: string): CellsWorkbook => {
  if (/\.(csv|tsv)(\?.*)?$/i.test(name)) {
    const rows: CellValue[][] = parseCsvText(text).map((row) =>
      row.map((field): CellValue => {
        const input = parseInput(field);
        // A formula typed into a CSV cell stays text: a file is data, not a program.
        if (typeof input === 'object' && input !== null && ('formula' in input || 'value' in input))
          return field;
        return input as CellValue;
      }),
    );
    return fromRows(rows);
  }
  return validateWorkbook(JSON.parse(text));
};

type Loaded = { model: CellsModel } | { error: string } | null;

export default function CellsClient(props: CellsClientProps): JSX.Element {
  const { data, src, height, theme, editable, label } = props;
  const colorMode = useSyncExternalStore(watchColorMode, siteColorMode, () => 'light' as const);
  const [loaded, setLoaded] = useState<Loaded>(null);

  useEffect(() => {
    let cancelled = false;
    const settle = (next: Loaded) => {
      if (!cancelled) setLoaded(next);
    };
    const make = (workbook: unknown) => ({
      model: createCellsModel({ data: validateWorkbook(workbook), readOnly: !editable }),
    });
    if (src === undefined) {
      try {
        settle(make(data));
      } catch (error) {
        settle({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    fetch(src)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${src}: ${response.status} ${response.statusText}`);
        return workbookOf(src, await response.text());
      })
      .then((workbook) => settle(make(workbook)))
      .catch((error: unknown) =>
        settle({ error: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      cancelled = true;
    };
  }, [data, src, editable]);

  return (
    <ThemeProvider colorMode={colorMode}>
      <BaseStyles>
        <div style={{ height, margin: '1.5rem 0' }} data-cells-docusaurus="">
          {loaded === null ? (
            <div aria-busy="true">Loading the sheet…</div>
          ) : 'error' in loaded ? (
            <div role="alert">The sheet cannot be shown: {loaded.error}</div>
          ) : (
            <Spreadsheet
              model={loaded.model}
              theme={theme}
              colorMode={colorMode}
              aria-label={label}
            />
          )}
        </div>
      </BaseStyles>
    </ThemeProvider>
  );
}
