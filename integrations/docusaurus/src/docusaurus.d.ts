/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/*
 * The few Docusaurus modules the theme imports, typed here rather than by
 * installing Docusaurus into the cells repository: they exist only in the
 * site's webpack, which resolves them.
 */

declare module '@docusaurus/BrowserOnly' {
  import type { ReactNode } from 'react';
  export default function BrowserOnly(props: {
    children: () => ReactNode;
    fallback?: ReactNode;
  }): ReactNode;
}

declare module '@docusaurus/useGlobalData' {
  export function usePluginData(name: string, id?: string): unknown;
}

declare module '@docusaurus/useBaseUrl' {
  export default function useBaseUrl(url: string): string;
}

declare module '@datalayer/cells-docusaurus/client' {
  import type { ComponentType } from 'react';
  import type { CellsClientProps } from './client/CellsClient.js';
  const CellsClient: ComponentType<CellsClientProps>;
  export default CellsClient;
}
