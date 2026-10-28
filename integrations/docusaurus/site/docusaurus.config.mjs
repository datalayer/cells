/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Cells in Docusaurus',
  url: 'https://cells.datalayer.tech',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  presets: [
    [
      'classic',
      {
        docs: { routeBasePath: '/', sidebarPath: './sidebars.mjs' },
        blog: false,
      },
    ],
  ],
  plugins: [['@datalayer/cells-docusaurus', { cellsDir: 'cells', maxCells: 10000 }]],
  themeConfig: {
    navbar: { title: 'Cells in Docusaurus' },
    colorMode: { respectPrefersColorScheme: true },
  },
};

export default config;
