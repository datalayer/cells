# Code cells

A cell can hold Python instead of a value or a formula. Running it executes
the code on a Jupyter kernel; its result becomes the cell's value, which
formulas read like any other; its rich outputs (a figure, a table, HTML)
show in a frame beside the cell. The grid, the model and the file format
know code cells; running them and drawing their outputs is
`@datalayer/cells/jupyter`, the one entry that imports
`@datalayer/jupyter-react` (an optional peer), which a host loads when it
wants code to run.

## Writing and running

A code cell is `SET_CODE` with a `CodeCell` (`codeCell(source)` makes one),
or *Make the cell a code cell* (`cells.code.insert`) in the context menu.
The canvas paints a badge, the result (or the source's first line before a
run), `#BUSY!` while it runs and a corner mark when what it reads changed.
A cell with outputs paints a preview of them too: a PNG's thumbnail scaled
to the cell's height, or the first line of a text output, and an output
glyph in the corner; hovering the cell (300 ms) or Alt+Down shows the
outputs in a preview at the cell, drawn by the contributed renderer, up to
480 × 360. A cell whose `frame` is set keeps them pinned beside the cells
instead (`frame: null` shows the preview only). A host whose bundler is not
webpack defines `__webpack_public_path__` (`''`) before loading `./jupyter`,
as the examples' Vite config and page do: JupyterLab's packages read it.

| Keys, on a code cell | Command                | What it does                                   |
| -------------------- | ---------------------- | ---------------------------------------------- |
| Shift+Enter          | `cells.code.run`       | Run it on the sheet's kernel                   |
| Enter, F2, F4, a double-click | `cells.code.openEditor` | An overlay at the cell with the source in `Cell`; Escape, a click outside or Ctrl+S save and close; Shift+Enter there runs |
| Alt+Down | `cells.code.preview` | Its outputs in a preview at the cell (a hover of 300 ms too); Escape closes |
|                      | `cells.code.goToOutput` | Focus its output frame (Escape returns)       |
|                      | `cells.code.runAll`    | Every code cell of the sheet, in dependency order |
|                      | `cells.code.interrupt` | Stop the run in flight                         |

The code reads the sheet through `cells` (`from datalayer_cells import
cells`, the workbook the kernel is bound to): `cells["A1:B10"]` is the
range's values, a pandas DataFrame when pandas is there (the first row its
header when it is text over values), rows otherwise, and a single cell its
value. Values, never formulas. The ranges a run read are reported back to
the grid and become the cell's precedents. The
last expression's value is the result: a number, a string, a boolean or
`None`; anything else (a DataFrame, a figure, an `Image`) is displayed in
the frame and its kind is the result. An exception is `#ERROR!`, with the
traceback in the frame. Writing the sheet is `cells["C2"] = 42` and
`cells["E1:F3"] = df` (a DataFrame spilled from E1, refused with `#SPILL!`
over a cell that holds something): collaboration patches attributed to the
code cell, through the document the kernel holds (below).

A run is one undo step on the page: the result and the outputs. A
kernel's writes are another peer's edits: undone by running the cell
again, or by *Undo the cell's writes*.
The ranges a cell reads are compared after every change: a `manual` cell
(the default) is marked stale; an `auto` cell runs again after 300 ms, one
at a time, in dependency order. Nothing runs when a workbook opens; the
first run of a session is always a person's gesture.

## Kernels

Runs go to the first `datalayer.cells.kernel` contribution (a
`KernelProvider`: `{ id, label, connect() }`). `@datalayer/cells/jupyter`
offers `liteKernel()` (JupyterLite's Pyodide, in the page, no server) and
`serviceManagerKernel(manager)` (a Jupyter server or a Datalayer runtime),
and `CellsJupyterPlugin(provider)` contributes one with jupyter-react's
`Output` and `Cell` as the code renderer. With no kernel, a run says *No
kernel*. A kernel that is not Python gets the program too: `programParts`
gives it the source and the values read, and it answers with a
`display_data` output under `RESULT_MIME` (the plugin guide shows one).

The kernel holds a live copy of the workbook, the collaboration document
(the Loro document of the collab entry), bound to
`datalayer_cells.LiveWorkbook` through loro-py (`pip install
datalayer-cells[live]`), over one of two transports the page chooses:

- a room joined over the rooms' websocket with the page's token
  (`datalayer_cells.join(url, room, token)`): a server kernel, a second peer
  beside the page, its writes merged like another person's;
- the `datalayer.cells` Jupyter comm the page opens on the kernel it runs
  code on (`openCellsComm` in `./jupyter`; a kernel with a `binding`
  opens it on the first run): the page sends the document's snapshot, then
  every update, and takes the kernel's updates back, the same Loro bytes the
  websocket carries. Where loro-py cannot run (the browser's Pyodide has no
  wheel for it) the comm carries the workbook as JSON instead and the
  kernel's writes come back as `SET_CELLS`, one undo step named after the
  cell: the same `cells` API, one format less faithful.

`from datalayer_cells import cells` is the workbook the kernel is bound to;
a run records the ranges it reads and answers them to the grid, which makes
them the cell's precedents (no parsing of the source). A kernel without the
package gets a snapshot of the values the source names instead.

## Files

`CellsWorkbook` JSON keeps code cells under `sheets[].code["B4"]`: the
source, the outputs (nbformat's), the result, the execution count, when it
last ran, `run`, the frame's size and the spill's. XLSX has no place for
code: the sources and their settings go into `customXml/cells-code.xml`,
the result is the cell's cached value, and the outputs are dropped, which
the import report says (`report.code`). The `ipynb` exporter writes the
code cells as a notebook, one code cell each in reading order with its
outputs, the sheet and cell in its metadata. CSV writes the result.

## Security

- Code runs only on a kernel the host contributed, never on open, and
  first on a person's gesture. The kernel is the host's: the browser's
  Pyodide runs in the page, a server runs what the server allows.
- Outputs from a file, a paste or another person are **untrusted** until
  the cell runs here: the frame shows their text and images only
  (`safeOutputs`: `text/plain`, `image/png`, `image/jpeg`, `image/gif`,
  `text/latex`); HTML, SVG, scripts and widgets are replaced by a line
  saying what was held. A run in this session trusts the cell's outputs
  (`model.codeTrusted`), and loading another workbook forgets the trust.
  The renderer receives `trusted` and the filtered outputs; jupyter-react's
  own sanitiser applies on top.
- A host turns code cells off with `codeCells: false`: their sources,
  results and outputs are shown as they are, and `SET_CODE` and every run
  are refused (`CodeCellsOff`, *Code cells are off here*).
- A code cell reads values, never formulas; its writes are collaboration
  patches attributed to it, so undo and collaboration stay cell-shaped.
- Outputs travel with the workbook through collaboration like any content;
  keep a workbook's outputs small (frames over 200 kB render on demand).
