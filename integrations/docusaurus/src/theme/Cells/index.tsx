/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * `<Cells>` — a live sheet in an MDX page.
 *
 * Drawn in the browser only: during the prerender, and until the grid has
 * loaded, the page holds the sheet's place with a box of its height, so
 * nothing moves when the grid arrives. The grid itself is loaded from a
 * module the server build is given nothing for (see the plugin's
 * `configureWebpack`).
 */

import type { CSSProperties, JSX } from 'react';
import { lazy, Suspense } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import { usePluginData } from '@docusaurus/useGlobalData';
import useBaseUrl from '@docusaurus/useBaseUrl';

const CellsClient = lazy(() => import('@datalayer/cells-docusaurus/client'));

export type CellsProps = {
  /** A workbook as data: usually a `.cells.json` the page imports. */
  data?: unknown;
  /** A `.cells.json` or `.csv` file the site serves (`/data/sales.csv`), read in the browser. Never with `data`. */
  src?: string;
  /** The sheet's height in CSS px; 320 when absent. */
  height?: number;
  /** Whether readers may edit the sheet (the site's default when absent). */
  editable?: boolean;
  'aria-label'?: string;
};

const placeholderStyle = (height: number): CSSProperties => ({
  height,
  width: '100%',
  margin: '1.5rem 0',
  border: '1px solid var(--ifm-color-emphasis-300)',
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ifm-color-emphasis-600)',
});

const Placeholder = ({ height, label }: { height: number; label?: string }): JSX.Element => (
  <div style={placeholderStyle(height)} aria-busy="true">
    {label ? `${label} — loading the sheet…` : 'Loading the sheet…'}
  </div>
);

export default function Cells(props: CellsProps): JSX.Element {
  const { data, src, height = 320, editable } = props;
  if ((data === undefined) === (src === undefined))
    throw new Error(
      '<Cells> takes data (a workbook) or src (a file the site serves), not both nor neither.',
    );
  const site = usePluginData('docusaurus-plugin-cells') as
    { theme?: string; editable?: boolean } | undefined;
  const url = useBaseUrl(src ?? '');
  const label = props['aria-label'];
  const placeholder = <Placeholder height={height} label={label} />;
  return (
    <BrowserOnly fallback={placeholder}>
      {() => (
        <Suspense fallback={placeholder}>
          <CellsClient
            data={data}
            src={src === undefined ? undefined : url}
            height={height}
            theme={site?.theme ?? 'loop'}
            editable={editable ?? site?.editable ?? false}
            label={label}
          />
        </Suspense>
      )}
    </BrowserOnly>
  );
}
