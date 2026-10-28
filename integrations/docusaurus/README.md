[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

# ☰ 🦠 🦕 Datalayer Cells Integration for Docusaurus

`@datalayer/cells-docusaurus` shows [Datalayer Cells](../../README.md) in a
[Docusaurus](https://docusaurus.io) site: a workbook written as data in a
`.cells.json` file beside the docs, or a `.csv` file the site serves, shown as
a live sheet in any MDX page with `<Cells>`.

- **Checked when the site builds.** Every `.cells.json` and `.csv` under the
  site's `cells` directory is checked by `docusaurus build` and
  `docusaurus start`, with the grid's own loader and parser: a workbook that
  the grid would refuse fails the build with the path of the bad field; a
  CSV file that is empty or ragged fails it with the row.
- **Drawn in the browser only.** The grid (React, canvas and Primer) is kept
  out of the server bundle; the page holds the sheet's place with a box of
  its height until it arrives.
- **In the site's colour mode.** The sheet wears a primer-addons theme
  (`loop` unless the site names another) in the colour mode the site's own
  switch chose, following it when the reader switches.
- **One React.** React is pinned to the site's own copy.

## Install

```bash
npm install @datalayer/cells-docusaurus @datalayer/cells @datalayer/reactor @primer/react @primer/octicons-react @datalayer/primer-addons
```

## Configure

```js
// docusaurus.config.js
export default {
  plugins: [['@datalayer/cells-docusaurus', { cellsDir: 'cells', maxCells: 10000 }]],
};
```

| Option     | Default | What it does                                                                         |
| ---------- | ------- | ------------------------------------------------------------------------------------ |
| `cellsDir` | `cells` | Where the site's `.cells.json` and `.csv` files are, from the site's directory.       |
| `maxCells` | none    | The most cells a file may hold: a larger one fails the build.                        |
| `theme`    | `loop`  | The primer-addons theme variant the sheets wear: `loop`, `datalayer`, and the rest.   |
| `editable` | `false` | Whether readers may edit the sheets (edits stay in the page).                        |

## Show a sheet in a page

```mdx
import Cells from '@theme/Cells';
import budget from '@site/cells/budget.cells.json';

<Cells data={budget} aria-label="Budget" height={240} />

<Cells src="/data/sales.csv" aria-label="Sales" />
```

`data` is a workbook the page imports (checked at build time when it lives
under `cellsDir`); `src` is a `.cells.json` or `.csv` file the site serves
from `static/`, read in the browser. `height` is the sheet's height in CSS px
(320 by default); `editable` overrides the site's default for one sheet.

## The sample site

[`site/`](site/) is a Docusaurus site on this repository's own packages: build
the grid (`npm run build` at the repository's root) and this integration
(`npm install --legacy-peer-deps && npm run build` here), then, in `site/`,
`npm install --legacy-peer-deps` (the peers), `npm run install:local` (this
checkout's two packages, packed from `lib/`) and `npm run build`. The build
checks `site/cells/budget.cells.json`, and `npm run serve` shows the page with
its two live sheets.
