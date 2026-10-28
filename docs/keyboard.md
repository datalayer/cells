# The keyboard

The grid follows Excel and Google Sheets. `Mod` is Ctrl on Windows and Linux,
Cmd on macOS. The keys are bound on the grid's own focus target, never on the
window, so several grids share a page.

Every shortcut the grid handles is a Reactor command (`cells.*`), contributed
by the built-in plugins (`CellsEditingPlugin`, `CellsNavigationPlugin`,
`CellsFillPlugin`) and found by the grid's one keybinding lookup. A host
rebinds or unbinds any of them through the `keymap` prop:

```tsx
<Spreadsheet keymap={{ 'cells.bold': 'Mod+Shift+B', 'cells.italic': null, 'cells.editCell': 'Mod+E' }} />
```

A keymap entry replaces every key of its command. A plugin's commands in the
`Cells` category with a key join them.

A command has two kinds of key. Its `keybinding` is the Reactor one: a
command palette (`@datalayer/reactor-commands`, Mod+K) shows it and binds it
on the whole page while it is mounted. Its `gridKeybindings` are bound on the
grid's focus target alone, so an arrow, Enter, Delete or Mod+A typed in any
other field keeps that field's meaning; a palette shows them in the
command's description. Run by its id with no argument (a palette, an agent),
a command acts on the grid that last had the focus.

## Moving and selecting (grid keys)

| Keys                   | Command                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| Arrows                 | `cells.moveUp`, `cells.moveDown`, `cells.moveLeft`, `cells.moveRight`            |
| Mod+Arrows             | `cells.jumpUp`, `…Down`, `…Left`, `…Right`: to the edge of the data              |
| Shift+Arrows           | `cells.extendUp`, `…Down`, `…Left`, `…Right`                                     |
| Mod+Shift+Arrows       | `cells.extendJumpUp`, `…Down`, `…Left`, `…Right`                                 |
| Tab, Shift+Tab         | `cells.nextRight`, `cells.nextLeft` (inside a selection: cycle through it)       |
| Enter, Shift+Enter     | `cells.nextDown`, `cells.nextUp` (inside a selection: cycle through it)          |
| Home, Shift+Home       | `cells.goToRowStart`, `cells.extendToRowStart`: the row's first cell             |
| Mod+Home, Mod+Shift+Home | `cells.goToStart`, `cells.extendToStart`: A1                                   |
| Mod+End, Mod+Shift+End | `cells.goToEnd`, `cells.extendToEnd`: the last cell holding data                 |
| PageDown, PageUp       | `cells.pageDown`, `cells.pageUp` (with Shift: `cells.extendPageDown`, `…Up`)     |
| Ctrl+Space             | `cells.selectColumns`                                                            |
| Shift+Space            | `cells.selectRows`                                                               |
| Mod+A                  | `cells.selectAll`                                                                |
| Shift+F10, ContextMenu | `cells.openContextMenu`: at the active cell                                      |
| Escape, then Tab       | Leave the grid (no keyboard trap; not a command, so no keymap can trap the focus) |

## Editing

| Keys                       | Command, or what they do                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| F2                         | `cells.editCell`: edit the active cell, keeping its content                     |
| Backspace                  | `cells.clearAndEdit`: empty the active cell and edit it                         |
| Delete                     | `cells.clearContents`: clear the selection's contents (one undo step)           |
| Mod+Z                      | `cells.undo`                                                                    |
| Mod+Y, Mod+Shift+Z         | `cells.redo` (Mod+Shift+Z is a grid key)                                        |
| Mod+D, Mod+R               | `cells.fillDown`, `cells.fillRight`                                             |
| Shift+Enter, on a code cell | `cells.code.run`: run it on the sheet's kernel (elsewhere, `cells.nextUp`)     |
| F4, on a code cell         | `cells.code.openEditor`: the source in the contributed editor (jupyter-react's `Cell`) |
| Typing                     | Replace the active cell's content (not on a cell type that says so)             |
| Enter, Tab                 | In the editor: commit and move (Alt+Enter: a new line in the cell)              |
| Escape                     | In the editor: leave the cell as it was; on the grid: drop the copy marquee     |
| F4                         | While editing a formula: toggle the `$` anchors of the reference                |
| Mod+C, Mod+X, Mod+V        | Copy, cut, paste (TSV and HTML, with Excel, Sheets and LibreOffice)             |
| Mod+Shift+V                | Paste values only                                                               |

Typing, the editor's own keys and the clipboard are not commands. Typing a
character starts the editor with it (an IME's first key opens it empty), and
the editor's keys act inside it. Copy, cut and paste are the browser's own
clipboard events, the only ones that carry the system clipboard both ways (a
page cannot read the clipboard from a key of its own without a permission
prompt), so the browser's Mod+C, Mod+X and Mod+V reach them; Mod+Shift+V
marks the next paste as values only.

While a formula is edited, the arrows and the pointer insert or extend a
reference (point mode), and the function list completes names.

## Cell types

| Keys  | On          | What they do      |
| ----- | ----------- | ----------------- |
| Space | a checkbox  | Toggle it         |
| Enter | a link      | Open it (new tab) |

A plugin's cell type lists its own keys (`activateOn`).

## Formatting and structure

| Keys                       | Command                                    |
| -------------------------- | ------------------------------------------ |
| Mod+B, Mod+I, Mod+U        | `cells.bold`, `cells.italic`, `cells.underline` |
| Mod+5                      | `cells.strikethrough`                      |
| Mod+Shift+!                | `cells.formatNumber`                       |
| Mod+Shift+$                | `cells.formatCurrency`                     |
| Mod+Shift+%                | `cells.formatPercent`                      |
| Mod+Shift+#                | `cells.formatDate`                         |
| Mod+Shift+~                | `cells.formatGeneral`                      |
| Mod+Alt+=                  | `cells.insert` (rows above, or columns left of whole columns) |
| Mod+Alt+-                  | `cells.delete` (rows, or whole columns)    |
| Alt+Shift+Arrows           | `cells.moveRowsUp`, `…Down`, `cells.moveColumnsLeft`, `…Right` |
| Mod+Alt+9, Mod+Shift+9     | `cells.hideRows`, `cells.unhideRows`       |
| Mod+Alt+0, Mod+Shift+0     | `cells.hideColumns`, `cells.unhideColumns` |

## Charts

With a chart selected (a click on its frame, or *Go to chart* from the
context menu): the arrows move it by a cell (`cells.chart.moveUp`, …),
Shift+arrows resize it (`cells.chart.growDown`, `…shrinkUp`, …), Delete or
Backspace removes it (`cells.chart.delete`), Shift+Enter selects its data in
the grid (`cells.chart.showData`), and Escape returns to the cells. These keys
run the chart commands only while a chart is selected, and fall to the cells'
own commands otherwise, so they are not rebound by the keymap.
