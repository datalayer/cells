# Extending Cells with a Reactor plugin

Cells is built on [Reactor](https://github.com/datalayer/reactor). Every way
to extend a grid is a Reactor **contribution point** named `datalayer.cells.*`,
and the built-in features (the formula functions, the cell types, the fill
rules, the clipboard handlers, CSV and XLSX, the chrome, charts, collaboration)
are plugins contributing through the same points. A third-party plugin is
written exactly the same way, and a grid runs on the core plugin plus any set
of them.

This guide walks through [`examples/src/examples/plugin/acme.ts`](../examples/src/examples/plugin/acme.ts),
the `@acme/everything` plugin of the examples site (the *A Reactor plugin*
page, https://cells.datalayer.tech/#/plugin), which contributes to every
point. The tests in `src/points/__tests__/everyPoint.test.ts` run each
contribution on a grid built from `CellsCorePlugin` and that plugin alone.

## A plugin, and a grid that runs on it

```ts
import { contribution, definePlugin, buildReactorFromPlugins } from '@datalayer/reactor';
import { CellsCorePlugin, CellsFunctions, createCellsModel, Spreadsheet } from '@datalayer/cells';

export const MyPlugin = definePlugin({
  name: '@acme/my-plugin',
  displayName: 'My plugin',
  contributes: [contribution(CellsFunctions, { name: 'SHOUT', /* … */ }, { id: 'SHOUT' })],
});

// With the built-ins (functions, cell types, fill, clipboard, …) and your plugin:
const model = createCellsModel({ plugins: [MyPlugin] });
<Spreadsheet plugins={[MyPlugin]} />;

// On a platform you own, with the core plugin and nothing else:
const reactor = buildReactorFromPlugins([CellsCorePlugin, MyPlugin]);
reactor.start();
const bare = createCellsModel({ reactor });
```

A host already running Reactor passes its platform (`reactor`), with
`CellsCorePlugin` among its plugins, so a plugin installed in the host extends
every grid. `@datalayer/reactor` is a peer dependency: host and Cells share
one instance.

**Resolution.** The model reads each point once into a table keyed by id
(a function's name, a command's type, a cell type's id, …), and reads it
again only when the platform's revision moves (a plugin enabled or disabled).
A key contributed twice is refused **at start**, with a sentence naming both
plugins:

```
The function 'SHOUT' is contributed twice to datalayer.cells.function: by
@acme/everything (id 'SHOUT') and by @acme/twice (id 'SHOUT'). Disable one of
the two plugins, or rename one function.
```

A contribution of the wrong shape is refused naming its plugin and id. A
plugin switched off takes its contributions with it: formulas that used its
functions show `#NAME?`, cells of its types draw as plain values, its layers
stop drawing, a sheet bound to its data source says so in the cells.

## The points

The ids below are the `datalayer.cells.*` points `CellsCorePlugin` declares
(`CELLS_POINTS`); the types are exported from `@datalayer/cells` (and from
`@datalayer/cells/core` for code that must not reach React).

### `command` — `CommandHandler`

A command is a typed object the model dispatches; its handler refuses it with
reasons (`allow`) or turns it into patches (`apply`). A command never declares
its own undo: undo replays the inverses of the patches it produced.

```ts
contribution(CellsCommands, {
  type: 'UPPERCASE',
  apply: ({ workbook }, c: { type: 'UPPERCASE'; sheet: string; zone: Zone }) => {
    const sheet = workbook.sheet(c.sheet);
    const contents = [...sheet.cells.entries(c.zone)]
      .filter(([, , x]) => typeof x.value === 'string' && x.formula === undefined)
      .map(([row, col, x]) => [row, col, { ...x, value: (x.value as string).toUpperCase() }] as const);
    return contents.length === 0 ? [] : [cellsPatch(sheet, c.zone, contents)];
  },
}, { id: 'UPPERCASE' });

model.dispatch({ type: 'UPPERCASE', sheet: 's1', zone: { top: 1, left: 0, bottom: 1, right: 1 } });
```

`cellsPatch` builds a core `cells` patch (a zone with its cells before and
after). A plugin that needs state of its own registers a patch op.

### `patchOp` — `PatchOp`

A patch op is how a change is applied and undone: `apply(workbook, patch)`,
`invert(patch)` (a patch is its own inverse's type) and `example(workbook)`,
which the forcing test uses to check `invert(invert(p))` is `p` for every op
of every plugin. Acme keeps notes on cells beside the workbook:

```ts
contribution(CellsPatchOps, {
  op: 'acme.note',
  apply: (workbook, p) => { /* write p.after into the plugin's own map */ },
  invert: (p) => ({ ...p, before: p.after, after: p.before }),
  example: () => ({ op: 'acme.note', sheet: 's1', row: 0, col: 0, before: null, after: 'Check this' }),
}, { id: 'acme.note' });
```

### `function` — `FormulaFunction`

A formula function: an upper-case name, typed arguments (`scalar`, `range`,
`any`, `lazy`), `compute(args, context)`, and metadata for autocomplete and
the functions page. An `async` function returns a promise: its cell shows
`#BUSY!` until it settles, then its dependents recalculate.

```ts
contribution(CellsFunctions, {
  name: 'ECHO',
  args: [{ name: 'text', type: 'scalar' }],
  returns: 'string',
  category: 'text',
  async: true,
  compute: ([text]) => fetchFromSomewhere(toText(text as CellValue)),
  description: 'The text, twice, after a while.',
  examples: ['=ECHO("hey") → hey…hey'],
}, { id: 'ECHO' });
```

### `cellType` — `CellType`

A cell takes a type through its style: `{ type: 'megaphone' }`, set with
`SET_STYLE` as any style property (per cell, row or column; persisted, synced
and undone with the style). The type draws the cell (`render`, in a rectangle
that carries its `zoom`), says how wide it wants to be (`measure`, for *Fit
columns*), what a click (`hitTest`, `activate`) or a key (`activateOn`) does, a
command the grid dispatches or a URL it opens, whether typing edits it
(`editable`), and what a screen reader hears (`accessibleName`).

```ts
contribution(CellsCellTypes, {
  id: 'megaphone',
  render: (ctx, rect, value, style, theme) => { /* draw on the canvas */ },
  accessibleName: (value) => `Shouted: ${toText(value).toUpperCase()}`,
}, { id: 'megaphone' });
```

The built-in `checkbox` (Space toggles), `link` (Enter opens) and `progress`
types are written the same way, in `src/builtins/cellTypes.ts`.

### `renderLayer` — `RenderLayer`

A layer drawn after the core layer of its kind, once per pane, clipped to it:
`background` (after the fills and grid lines), `cells` (after the text and
borders), `overlay` (after the selection, on the overlay canvas). `draw(ctx,
view, model)` gets the pane's rows and columns, its zoom and `cellRect(row,
col)`; `model` is the `CellsModel` drawn.

```ts
contribution(CellsRenderLayers, {
  id: 'acme.noteMarks',
  layer: 'cells',
  draw: (ctx, view, model) => { /* a red corner on each noted cell of view.zone */ },
}, { id: 'acme.noteMarks' });
```

### `clipboard` — `ClipboardHandler`

One handler per feature: `copy(context, sheet, zone)` returns its part of the
slice (or `undefined`), `paste(context, sheet, part, target, options, source)`
turns the part into patches. The built-ins handle cells, merges, sizes and
charts; Acme carries its notes.

### `fillRule` — `FillRule`

The fill handle tries the rules in `order`; the first whose `match(source)`
returns a series wins, and `next(series, index)` gives the value at each index
past the source (negative indexes fill backwards). Acme extends Roman
numerals: I, II, III → IV, V, …

### `importer` and `exporter` — `Importer`, `Exporter`

An importer reads a file (`string`, `Uint8Array` or a stream) into a
`CellsWorkbook`; an exporter writes a model out. Both are found by MIME type
and extension. Acme reads and writes Markdown tables.

### `dataSource` — `DataSource`

A read-only, paged source of columns: an id, a `rowCount`, `columns` and
`fetch({ from, to })`, which resolves to one array per column for those rows.
A sheet binds a source at a cell with `BIND_DATA_SOURCE`; its rows show from
there, read in pages of 1,024 rows as the grid scrolls over them and as
formulas read them (`#BUSY!` meanwhile), kept in a bounded cache, `#N/A` with
the sentence when a page fails (and `onDataSourceError` told). The bound
cells cannot be edited.

```ts
contribution(CellsDataSources, {
  id: 'acme.primes',
  rowCount: 100_000,
  columns: [{ name: 'n', type: 'number' }, { name: 'prime', type: 'number' }],
  fetch: ({ from, to }) => server.primes(from, to), // → [ns, primes]
}, { id: 'acme.primes' });

model.dispatch({ type: 'BIND_DATA_SOURCE', sheet: 's1', source: 'acme.primes', at: { row: 1, col: 5 } });
```

### `collabProvider` — `CollabProvider`

How a shared document reaches its peers: `connect(doc, room)` returns the
provider. Exactly one wins (the first by `order`; none means collaboration
off; a tie at the winning order is refused). The built-in provider is
lexical-loro's WebSocket transport; Acme's `acme.local` relays updates
between the documents of one page, with no server.

### `toolbarItem` and `menuItem` — `CommandItem`

An entry naming a Reactor command by id, with an optional `group`. The
command itself goes in the plugin's `commands` (`id`, `name`, `octicon`,
`keybinding`, `execute({ model })`), so the toolbar, the context menu, a
shell's palette and a keybinding all run the same thing.

```ts
definePlugin({
  name: '@acme/everything',
  commands: [{ id: 'acme.uppercase', name: 'UPPERCASE the selection', keybinding: 'Mod+Shift+U',
    execute: ({ model }) => { /* dispatch UPPERCASE on the selection */ } }],
  contributes: [
    contribution(CellsToolbarItems, { command: 'acme.uppercase', group: 'acme' }, { id: 'acme.uppercase' }),
    contribution(CellsMenuItems, { command: 'acme.uppercase', group: 'acme' }, { id: 'acme.uppercase' }),
  ],
});
```

### `chartType`, `chartOption` and `chartRenderer`

A chart type (`ChartType`) brings the ECharts modules it needs (`modules`,
registered by `@datalayer/cells/charts` when the type is resolved, so the
built-ins never load a radar chart), its `option(spec, data, theme)` (a pure
function, tested in Node) and `describe(spec, data)` for a screen reader. A
chart option transform (`ChartOptionTransform`) rewrites every option after
its type built it, in `order`: a house style, a watermark. A chart renderer
(`ChartRenderer`) is the one component drawing charts: `@datalayer/cells/charts`
contributes ECharts at `order: 100`; Acme's text renderer at `order: 500`
draws when no ECharts is loaded.

### `gate.edit` — an edit gate

A gate lets a plugin veto a command before it applies: `check({ command,
context })` returns `true` or the sentence of the refusal, which comes back as
a `Gate` refusal of `dispatch`.

```ts
contribution(CellsEditGate, {
  check: ({ command }) =>
    command.type === 'SET_CELLS' && command.at.row === 0 ? "Row 1 is Acme's header row: locked." : true,
}, { id: 'acme.headerLocked' });
```

### `codeRenderer` — `CodeRenderer`

How code cells' outputs are drawn and their sources edited: `{ id, output,
editor? }`, two React components typed loosely (`CodeOutputRendererProps`:
the outputs, the cell's name, the frame's size; `CodeEditorRendererProps`:
the cell, the model, `onClose`). The first in `order` wins.
`@datalayer/cells/jupyter` contributes jupyter-react's `Output` and `Cell`;
with none, the grid shows the outputs' `text/plain` and a plain textarea.

### `kernel` — `KernelProvider`

The kernels code cells run on (§ code cells): `{ id, label, connect() }`,
where `connect` resolves, once, on the first run, to a `CellsKernel` whose
`execute(code)` gives back nbformat outputs. Runs go to the first kernel
contributed. `@datalayer/cells/jupyter` contributes jupyter-react's (the
browser's Pyodide, a Jupyter server, a Datalayer runtime); with none, a run
says *No kernel*. A kernel that is not Python reads the cell's source and
the values it reads with `programParts(code)` and answers with a
`display_data` output under `RESULT_MIME`:

```ts
export const wordCount = {
  id: 'acme.words',
  label: 'Acme word count',
  connect: async () => ({
    async execute(code: string) {
      const source = programParts(code)?.source ?? '';
      const words = source.split(/\s+/).filter((w) => w !== '').length;
      return {
        outputs: [
          { output_type: 'stream' as const, name: 'stdout', text: source },
          { output_type: 'display_data' as const, data: { [RESULT_MIME]: { result: words } } },
        ],
      };
    },
  }),
};
```

## From React

`useContributions(point)` lists a point's contributions with their plugins,
`usePlugin(name)` switches a plugin on and off, `useCellsCommands()` lists
the Reactor commands with their keybindings and `useExecuteCommand()` runs
one; `useCellType(ref)`, `useDataSource(sheet)` and `useCharts()` read what
the points resolved for a cell, a sheet and a chart. The *A Reactor plugin*
page shows them all.
