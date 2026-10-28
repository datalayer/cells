/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { createThemeStore } from '@datalayer/primer-addons';

/**
 * The examples' appearance, primer-addons' theme store: the Datalayer theme in
 * the system's light or dark at first, then what the reader chose under the
 * title, kept in this browser across reloads. One store for the whole site:
 * the root wears it, and the pages with their own chooser (Theming, Charts)
 * change the same choice.
 */
export const useAppearance = createThemeStore('cells-examples-theme', {
  colorMode: 'auto',
  theme: 'datalayer',
});
