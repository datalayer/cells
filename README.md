[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

[![Become a Sponsor](https://img.shields.io/static/v1?label=Become%20a%20Sponsor&message=%E2%9D%A4&logo=GitHub&style=flat&color=1ABC9C)](https://github.com/sponsors/datalayer)

# ☰ 🦠 Datalayer Cells

A spreadsheet drawn on canvas and exposed as a React component, over a
headless model that also runs in Node and in workers. Cells is built on
[Reactor](https://github.com/datalayer/reactor): every extension point (formula
functions, cell types, commands, importers and exporters, data sources, the
collaboration provider) is a Reactor contribution point, and the built-in
features are Reactor plugins contributing through the same points.

> Work in progress.

Formulas: 117 functions, each checked against what LibreOffice computes; the
list is in [docs/functions.md](docs/functions.md).

Charts: column, bar, line, area, pie, scatter and combo charts anchored on a
sheet, fed by ranges that follow recalculation, carried through XLSX, and drawn
with [Apache ECharts](https://echarts.apache.org) from `@datalayer/cells/charts`,
a lazy plugin the grid loads only when a chart is drawn. See them live on the
[charts example](https://cells.datalayer.tech/#/charts): twelve months of
figures with a column, a line, a doughnut and a combo chart beside them, in
light and dark.

## Packages

| Import                    | What                                                    |
| ------------------------- | ------------------------------------------------------- |
| `@datalayer/cells`        | the React component and hooks; re-exports `./core`      |
| `@datalayer/cells/core`   | the headless model: no React, no DOM                    |
| `@datalayer/cells/csv`    | CSV and TSV in and out                                  |
| `@datalayer/cells/xlsx`   | XLSX in and out, loaded lazily                          |
| `@datalayer/cells/collab` | real-time collaboration over Loro                       |
| `@datalayer/cells/chrome` | toolbar, formula bar and sheet tabs                     |
| `@datalayer/cells/charts` | charts drawn with Apache ECharts (an optional peer)     |

```bash
npm install @datalayer/cells @primer/react @primer/octicons-react @datalayer/primer-addons
```

`@primer/react`, `@primer/octicons-react` and `@datalayer/primer-addons` are
required peers: the grid's context menu, the chrome and the named themes are
Primer. `loro-crdt` (`./collab`), `@datalayer/lexical-loro` (its transport),
`echarts` and `echarts-for-react` (`./charts`) are optional peers, installed
by the hosts that use those entries.
| `@datalayer/cells/plugin` | views for a Reactor shell                               |

## Python

`datalayer_cells` reads and writes the same workbooks, with the same
validation, for agents and scripts, and adds the `datalayer cells` command
(also `datalayer-cells` on its own):

```python
from datalayer_cells import Workbook

wb = Workbook.load("budget.cells.json")
wb.read("Summary!A1:C4")            # rows of values
wb.write("B2", [[12, "=B1*2"]])     # formulas are kept as typed
wb.save("budget.cells.json")
```

```bash
datalayer cells show budget.cells.json
datalayer cells get budget.cells.json 'Summary!A1:C4'
datalayer cells set budget.cells.json B2 12 '=B1*2'
datalayer cells export budget.cells.json --format csv
```

## Examples

```bash
make examples       # http://127.0.0.1:3077
# The dev server loads loro-crdt's WebAssembly through vite-plugin-wasm and
# vite-plugin-top-level-await (devDependencies); a production build needs neither.
```

A page with a menu of examples, from a few values to collaboration, each with
its source. What is not built yet says so, and names the milestone that
brings it.

### Published

The examples are online at [cells.datalayer.tech](https://cells.datalayer.tech).
To publish a new version of them:

```bash
make build-examples   # builds the site into examples/dist
make deploy-examples  # builds, replaces the datalayer-cells S3 bucket, and refreshes the CDN
```

`deploy-examples` needs the AWS CLI with access to the `datalayer-cells`
bucket and the CloudFront distribution `EJMQSIG0ZTQVR`, from the `datalayer`
conda environment.

## Development

`@datalayer/reactor` resolves as a package: from npm, or from the workspace in
the Datalayer monorepo (install at its root).

```bash
npm install
npm run lint        # Prettier and the licence header on every file
npm run typecheck   # everything, tests and examples included
npm test            # unit tests (vitest, two workers), the React tests under React 19 and 18.3
npm run build       # lib/
npm run bench       # Node benches into bench/results/
python -m pytest    # the Python package (pip install -e ".[test]" first)
npm run size        # bundle sizes against their budgets
```

Browser benches and end-to-end tests run on the system Chrome, headless:

```bash
env -u WAYLAND_DISPLAY -u DISPLAY node scripts/bench.mjs --browser
```

## License

MIT, see [LICENSE](LICENSE).
