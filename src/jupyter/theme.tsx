/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * jupyter-react's theme around its components (`JupyterReactTheme`: the
 * JupyterLab CSS and variables, Primer's primitives), in the host's colour
 * mode. Its own module, reached through jupyter-react's `theme` entry, so a
 * test mounts it without the rest of jupyter-react.
 *
 * @module jupyter/theme
 */

import { JupyterReactTheme } from '@datalayer/jupyter-react/theme';
import { useTheme } from '@primer/react';

/** The colour mode the host shows: Primer's resolved one when a `ThemeProvider` is above, else the document's `data-color-mode`, else light. */
export function useHostColorMode(): 'light' | 'dark' {
  const { resolvedColorMode } = useTheme();
  const fromDocument =
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.colorMode;
  const dark =
    resolvedColorMode === 'night' || (resolvedColorMode === undefined && fromDocument === 'dark');
  return dark ? 'dark' : 'light';
}

/**
 * jupyter-react's theme around its components, in the host's colour mode.
 * Without it CodeMirror, the outputs and the kernel indicator render as
 * plain text.
 */
export function Themed({ children }: { readonly children: React.ReactNode }) {
  const mode = useHostColorMode();
  return (
    <JupyterReactTheme colormode={mode}>
      <div data-cells-jupyter-theme={mode}>{children}</div>
    </JupyterReactTheme>
  );
}
