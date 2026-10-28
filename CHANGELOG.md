<!--
  ~ Copyright (c) 2022-2026 Datalayer, Inc.
  ~
  ~ MIT License
-->

# Changelog

Both packages, `@datalayer/cells` on npm and `datalayer-cells` on PyPI, carry
one version (see `RELEASE.md`).

## 1.0.3 — 28 October 2026

1.0.2 reached PyPI but not npm (its release stopped on a missing TSDoc comment); 1.0.3 is the first of the two on both.

- **Code cells:** a run's outputs come from the executor's output model, so a displayed DataFrame lands in the grid (jupyter-react's `executor.outputs` lacked `output_type`); a refused write rejects the run with its refusal; a kernel without `datalayer_cells` (closed comm, or no answer in 5 s) runs on the values the code names.
- **Collaboration:** a row move no longer shifts the moved cells twice on the other peers; a delete keeps merges in place; a sheet added after two concurrent deletes no longer throws.
- **Python:** `LiveWorkbook` reads, adds, updates and removes charts in the live document (loro-py), as the TypeScript binding writes them; a Python peer joins the monkey party.

## 1.0.2 — 28 October 2026

- **Python reads and writes the sheet live** (`datalayer_cells.live`,
  `datalayer_cells.transport`): `cells[range]`, `cells[range] = value` or a
  DataFrame (spilling, `#SPILL!`), `on_change`, over a collaboration room or
  the `datalayer.cells` comm a page opens on the kernel it runs code on.
  `pip install datalayer-cells[live]` adds loro and websockets.
- **Code cells:** the editor overlay is jupyter-react's `Cell`, themed in the
  host's colour mode, with the kernel indicator; Run and Shift/Ctrl+Enter go
  through the grid's runner, so `cells` is defined and the result lands in
  the grid; a returned value shows on hover and under the editor; a kernel
  without `datalayer_cells` runs on the values the code names.
- **Reactor tables:** the command palette example lists the commands with
  `@datalayer/reactor-commands`' table, the plugin example the contribution
  points with `@datalayer/reactor-manager`'s (both need reactor 1.3.3).

## 1.0.1 — 28 October 2026

- **Agent tools.** `@datalayer/cells/plugin` exports `cellsAgentToolsPlugin`,
  the Cells bundle of the Reactor's agent-tools point: five commands that
  read, write, chart and select the grid on screen, installed with the shell
  plugins. `@datalayer/agent-runtimes` imports it.
- **Every grid shortcut is a Reactor command** (`cells.*`): F2, Backspace,
  Delete, Shift+F10 and the ContextMenu key, Mod+Shift+Z and every
  navigation key (arrows, Tab, Enter, Home, End, the pages, Ctrl+Space,
  Shift+Space, Mod+A) join the editing and structure commands, found by the
  grid's one keybinding lookup and rebound or unbound by the host's `keymap`;
  a command run with no argument acts on the grid that last had the focus.
  The *Command palette* example shows `@datalayer/reactor-commands` over a
  grid. `docs/keyboard.md` lists every shortcut with its command id.
- **The context menu is Primer's** `Overlay` and `ActionList` in the grid's
  own portal root, opaque on any host; hover focuses, a click runs, the
  arrows, Home, End, Escape and Tab work. `@primer/react`,
  `@primer/octicons-react` and `@datalayer/primer-addons` are peers.
- **Cell types** (`datalayer.cells.cellType`): a cell's type is its style's
  `type`, persisted, synced and undone with the style, in Python too; the
  built-in checkbox, link, progress bar and code.
- **Data sources** (`datalayer.cells.dataSource`): a sheet binds a paged,
  read-only source at a cell (`BIND_DATA_SOURCE`); its rows are read in
  pages, `#BUSY!` while a page is on its way, never saved.
- **The plugin page**: the examples' `@acme/everything` plugin reaches every
  `datalayer.cells.*` point (19 now), with the plugin guide `docs/plugins.md`
  walking through it.
- **Code cells, the first slices**: a cell holds Python (`SET_CODE`, the
  `code` cell type, `CodeCell` in the file format and in `datalayer_cells`);
  `@datalayer/cells/jupyter` runs it on a Jupyter kernel through
  `@datalayer/jupyter-react` (an optional peer): the browser's Pyodide or a
  server's; the result is the cell's value, the outputs show in a frame
  beside the cell, F4 opens the source in jupyter-react's `Cell`; the
  `ipynb` exporter; XLSX keeps the sources in `customXml/cells-code.xml`;
  `codeCells: false`; untrusted outputs show their text and images only
  until the cell runs here. The *Code cells* example page, with a Browser or
  Jupyter (prod1) kernel toggle. See `docs/code-cells.md`.
- `make start`, the same as `make examples`.
- The bench gate measures a timing over its budget again, up to three runs
  on CI, and gates its best run.

## 1.0.0 — 27 October 2026

The first release: the canvas grid, the formula engine, the file format,
XLSX and CSV, collaboration over Loro, charts, the chrome, the Docusaurus
integration and the Python package.
