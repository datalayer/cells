# The keyboard

The grid follows Excel and Google Sheets. `Mod` is Ctrl on Windows and Linux,
Cmd on macOS. The keys are bound on the grid's own focus target, never on the
window, so several grids share a page. Editing actions are Reactor commands
(`cells.*`): a host rebinds one through the `keymap` prop
(`keymap={{ 'cells.bold': 'Mod+Shift+B', 'cells.italic': null }}`), and a
plugin's commands with a `keybinding` join them. Navigation keys belong to
the grid and are not rebound.

## Moving and selecting

| Keys                             | What they do                                              |
| -------------------------------- | --------------------------------------------------------- |
| Arrows                           | Move the active cell                                      |
| Mod+Arrows                       | Jump to the edge of the data                              |
| Shift+Arrows, Shift+Mod+Arrows   | Extend the selection                                      |
| Tab, Shift+Tab                   | Move right or left (inside a selection: cycle through it) |
| Enter, Shift+Enter               | Move down or up (inside a selection: cycle through it)    |
| Home, Mod+Home                   | The row's first cell; A1                                  |
| Mod+End                          | The last cell holding data                                |
| PageDown, PageUp                 | A page down or up (with Shift: extend)                    |
| Mod+Space                        | Select the columns                                        |
| Shift+Space                      | Select the rows                                           |
| Mod+A                            | Select the whole sheet                                    |
| Escape, then Tab                 | Leave the grid (no keyboard trap)                         |
| Shift+F10, ContextMenu           | Open the context menu at the active cell                  |

## Editing

| Keys                       | What they do                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| Typing                     | Replace the active cell's content (not on a cell type that says so)  |
| F2                         | Edit the active cell, keeping its content                            |
| Enter, Tab                 | Commit and move (Alt+Enter: a new line in the cell)                  |
| Escape                     | Leave the cell as it was                                             |
| F4                         | While editing a formula: toggle the `$` anchors of the reference     |
| Backspace                  | Empty the active cell and edit it                                    |
| Delete                     | Clear the selection's contents                                       |
| Mod+C, Mod+X, Mod+V        | Copy, cut, paste (TSV and HTML, with Excel, Sheets and LibreOffice)  |
| Mod+Shift+V                | Paste values only                                                    |
| Mod+D, Mod+R               | Fill down, fill right                                                |
| Mod+Z, Mod+Y (Mod+Shift+Z) | Undo, redo                                                           |

While a formula is edited, the arrows and the pointer insert or extend a
reference (point mode), and the function list completes names.

## Cell types

| Keys  | On          | What they do      |
| ----- | ----------- | ----------------- |
| Space | a checkbox  | Toggle it         |
| Enter | a link      | Open it (new tab) |

A plugin's cell type lists its own keys (`activateOn`).

## Formatting and structure (Reactor commands)

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
context menu): the arrows move it by a cell, Shift+arrows resize it, Delete
removes it, Shift+Enter selects its data in the grid, and Escape returns to
the cells.
