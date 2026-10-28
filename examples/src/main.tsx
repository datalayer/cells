/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/** The examples: a menu from simple to advanced, one route per example, its source beside it. */

import { StrictMode, useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles, ThemeProvider } from '@primer/react';
import Minimal from './examples/01-minimal';
import Formulas from './examples/02-formulas';
import Editing from './examples/03-editing';
import Large from './examples/04-large';
import Theming from './examples/05-theming';
import ImportExport from './examples/06-import-export';
import ReactApi from './examples/07-react-api';
import Plugin from './examples/08-plugin';
import Collaboration from './examples/09-collaboration';
import Chrome from './examples/10-chrome';
import Charts from './examples/11-charts';
import CellTypes from './examples/12-cell-types';
import DataSources from './examples/13-data-sources';

const SOURCES = import.meta.glob('./examples/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Example {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly Component: ComponentType;
}

export const EXAMPLES: readonly Example[] = [
  { id: 'minimal', title: 'A few values', file: '01-minimal.tsx', Component: Minimal },
  {
    id: 'formulas',
    title: 'Formulas and recalculation',
    file: '02-formulas.tsx',
    Component: Formulas,
  },
  {
    id: 'editing',
    title: 'Editing, clipboard, fill and sort',
    file: '03-editing.tsx',
    Component: Editing,
  },
  { id: 'large', title: 'A million rows', file: '04-large.tsx', Component: Large },
  {
    id: 'theming',
    title: 'Theming',
    file: '05-theming.tsx',
    Component: Theming,
  },
  {
    id: 'import-export',
    title: 'Import and export',
    file: '06-import-export.tsx',
    Component: ImportExport,
  },
  { id: 'react-api', title: 'The React API', file: '07-react-api.tsx', Component: ReactApi },
  { id: 'plugin', title: 'A Reactor plugin', file: '08-plugin.tsx', Component: Plugin },
  {
    id: 'collaboration',
    title: 'Collaboration',
    file: '09-collaboration.tsx',
    Component: Collaboration,
  },
  {
    id: 'chrome',
    title: 'Toolbar, formula bar and sheet tabs',
    file: '10-chrome.tsx',
    Component: Chrome,
  },
  { id: 'charts', title: 'Charts', file: '11-charts.tsx', Component: Charts },
  { id: 'cell-types', title: 'Cell types', file: '12-cell-types.tsx', Component: CellTypes },
  {
    id: 'data-sources',
    title: 'Data sources',
    file: '13-data-sources.tsx',
    Component: DataSources,
  },
];

function useRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, '') || EXAMPLES[0].id;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function App() {
  const route = useRoute();
  const example = EXAMPLES.find((e) => e.id === route);
  return (
    <div className="layout">
      <nav aria-label="Examples">
        <h1>
          <span aria-hidden="true">🦠</span> Datalayer Cells
        </h1>
        <ol>
          {EXAMPLES.map((e) => (
            <li key={e.id}>
              <a href={`#/${e.id}`} aria-current={e.id === route ? 'page' : undefined}>
                {e.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <main>
        {example === undefined ? (
          <p role="alert">No example called '{route}'.</p>
        ) : (
          <>
            <h2>{example.title}</h2>
            <example.Component key={example.id} />
            <details className="source">
              <summary>Source: examples/src/examples/{example.file}</summary>
              <pre>{SOURCES[`./examples/${example.file}`]}</pre>
            </details>
          </>
        )}
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('The examples page has no #root.');
createRoot(root).render(
  <StrictMode>
    {/* The grid's context menu is a Primer Overlay: the pages without a theme chooser get Primer's theme here. */}
    <ThemeProvider colorMode="auto">
      <BaseStyles>
        <App />
      </BaseStyles>
    </ThemeProvider>
  </StrictMode>,
);
