/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The built-in editing actions, as Reactor commands contributed by a plugin
 * like any other: insert, delete, move, hide and unhide rows and columns,
 * merge, freeze, fit columns to their text, undo and redo, and the grid's
 * own editing keys: edit the cell, empty it, clear the selection, open the
 * context menu. Each acts on the selection of the model it is handed (or of
 * the grid that last had the focus, when it is run with no argument),
 * carries its keys, and joins the grid's context menu through the
 * `datalayer.cells.menuItem` point.
 *
 * @module builtins/editing
 */

import {
  contribution,
  definePlugin,
  formatKeybinding,
  type ReactorCommand,
} from '@datalayer/reactor';
import type { CommandResult } from '../core/commands.js';
import type { CellsModel } from '../core/model.js';
import type { Style } from '../core/styles.js';
import type { Zone } from '../core/zone.js';
import { CellsMenuItems, CellsToolbarItems } from '../points/index.js';
import { cellsArgument } from './target.js';

/** What a grid lends the commands that need more than its model: where it is scrolled, its menu, its page. */
export interface CellsGridAccess {
  /** The sheet the grid shows (keys act on it). */
  readonly sheet: string;
  /** The rows a page of the grid holds, for PageUp and PageDown. */
  readonly pageRows: number;
  /** Scroll so a cell shows. */
  scrollTo(row: number, col: number): void;
  /** Open the context menu at the active cell. */
  openMenu(): void;
  /** Focus a code cell's output frame (*Go to output*); `false` when it shows none. */
  focusOutput?(row: number, col: number): boolean;
  /** Open the contributed code editor over a code cell (*Open in editor*). */
  openCodeEditor?(row: number, col: number): void;
  /** Show a code cell's outputs in a preview at the cell (Alt+Down, a hover); `false` when it has none. */
  previewOutput?(row: number, col: number): boolean;
}

/** What a Cells command is run with: the grid's model, and how its text measures (for fitting). */
export interface CellsCommandArgument {
  readonly model: CellsModel;
  /** The width of a text in a cell's style, CSS px; the grid supplies it. */
  readonly measure?: (text: string, style: Style) => number;
  /** The chart type `cells.chart.insert` makes (the toolbar's picker); column by default. */
  readonly chartType?: string;
  /** The grid the command runs from, when a grid runs it (its keys, its menu). */
  readonly grid?: CellsGridAccess;
}

/**
 * A Cells command: a Reactor command over a grid's model, with the keys only
 * the grid binds. `keybinding` is the Reactor one, which a command palette
 * binds on the whole document while it is mounted; `gridKeybindings` are
 * bound on the grid's own focus target alone, so an arrow, Enter, Delete or
 * Mod+A typed in any other field on the page stays that field's. A host's
 * `keymap` entry replaces both.
 */
export type CellsCommand = ReactorCommand<CellsCommandArgument, unknown> & {
  readonly gridKeybindings?: readonly string[];
};

/** How a command's grid keys read in a palette, as its description. */
export function gridKeysDescription(keys: readonly string[], also: boolean): string {
  return `${also ? 'In the grid, also' : 'In the grid'}: ${keys.map((k) => formatKeybinding(k)).join(', ')}`;
}

/** The name of `CellsEditingPlugin`. */
export const CELLS_EDITING_PLUGIN = '@datalayer/cells-editing';

const last = (m: CellsModel): Zone => m.selection.zones[m.selection.zones.length - 1];

/** Throws a refusal's sentence, so a command's caller hears why. */
function check(result: CommandResult): CommandResult {
  if (!result.ok) throw new Error(result.refusals.map((r) => r.message).join(' '));
  return result;
}

type Action = (a: CellsCommandArgument) => CommandResult | boolean | void;

function command(
  id: string,
  name: string,
  run: Action,
  extra: Partial<CellsCommand> = {},
): CellsCommand {
  const keys = extra.gridKeybindings;
  return {
    id: `cells.${id}`,
    name,
    category: 'Cells',
    ...(keys !== undefined && keys.length > 0
      ? { description: gridKeysDescription(keys, extra.keybinding !== undefined) }
      : {}),
    ...extra,
    execute: (argument: CellsCommandArgument) => run(cellsArgument(`cells.${id}`, argument)),
  };
}

/** Edit the active cell, keeping its content (F2), scrolled into view. */
const editCell: Action = ({ model: m, grid }) => {
  if (m.readOnly) return;
  const at = m.selection.active;
  grid?.scrollTo(at.row, at.col);
  m.startEdit();
};

/** Empty the active cell and edit it (Backspace). */
const clearAndEdit: Action = ({ model: m }) => {
  if (m.readOnly) return;
  m.startEdit(undefined, '');
};

/** Clear the contents of every zone of the selection, as one undo step (Delete). */
const clearContents: Action = ({ model: m }) => {
  if (m.readOnly) return;
  const sel = m.selection;
  const results = m.transact('Clear', () =>
    sel.zones.map((zone) =>
      m.dispatch({ type: 'CLEAR', sheet: sel.sheet, zone, what: 'contents' }),
    ),
  );
  const refused = results.find((x) => !x.ok);
  if (refused !== undefined) check(refused);
};

/** Open the grid's context menu at the active cell (Shift+F10, the ContextMenu key). */
const openContextMenu: Action = ({ grid }) => {
  if (grid === undefined)
    throw new Error("cells.openContextMenu opens a grid's menu: run it from a grid.");
  grid.openMenu();
};

const insertRows =
  (below: boolean): Action =>
  ({ model: m }) => {
    const z = last(m);
    return check(
      m.dispatch({
        type: 'INSERT_AXIS',
        sheet: m.selection.sheet,
        axis: 'rows',
        at: below ? z.bottom + 1 : z.top,
        n: z.bottom - z.top + 1,
      }),
    );
  };
const insertCols =
  (right: boolean): Action =>
  ({ model: m }) => {
    const z = last(m);
    return check(
      m.dispatch({
        type: 'INSERT_AXIS',
        sheet: m.selection.sheet,
        axis: 'cols',
        at: right ? z.right + 1 : z.left,
        n: z.right - z.left + 1,
      }),
    );
  };

const moveAxis =
  (axis: 'rows' | 'cols', forward: boolean): Action =>
  ({ model: m }) => {
    const z = last(m);
    const sheet = m.selection.sheet;
    const [lo, hi] = axis === 'rows' ? [z.top, z.bottom] : [z.left, z.right];
    const n = hi - lo + 1;
    const to = forward ? hi + 2 : lo - 1;
    // One undo step: the move, and the selection moving with what it selected.
    return m.transact(axis === 'rows' ? 'Move rows' : 'Move columns', () => {
      const result = check(m.dispatch({ type: 'MOVE_AXIS', sheet, axis, at: lo, n, to }));
      const d = forward ? 1 : -1;
      const shifted =
        axis === 'rows'
          ? { ...z, top: z.top + d, bottom: z.bottom + d }
          : { ...z, left: z.left + d, right: z.right + d };
      const active =
        axis === 'rows'
          ? { ...m.selection.active, row: m.selection.active.row + d }
          : { ...m.selection.active, col: m.selection.active.col + d };
      const anchor =
        axis === 'rows'
          ? { ...m.selection.anchor, row: m.selection.anchor.row + d }
          : { ...m.selection.anchor, col: m.selection.anchor.col + d };
      m.select({ sheet, zones: [shifted], anchor, active });
      return result;
    });
  };

const hide =
  (axis: 'rows' | 'cols', hidden: boolean): Action =>
  ({ model: m }) => {
    const z = last(m);
    const sheet = m.selection.sheet;
    // Unhiding reaches one index past each side, as selecting around hidden rows does.
    const s = m.sheet(sheet);
    const count = axis === 'rows' ? s.rows.count : s.cols.count;
    let [from, to] = axis === 'rows' ? [z.top, z.bottom] : [z.left, z.right];
    if (!hidden) {
      from = Math.max(0, from - 1);
      to = Math.min(count - 1, to + 1);
    }
    return check(m.dispatch({ type: 'HIDE_AXIS', sheet, axis, from, to, hidden }));
  };

/** Fit the selected columns to their widest text (padding included), over every row that holds something. */
const fitColumns: Action = ({ model: m, measure }) => {
  if (measure === undefined)
    throw new Error('cells.fitColumns needs a measure: run it from a grid.');
  const z = last(m);
  const sheet = m.sheet(m.selection.sheet);
  return m.transact('Fit columns', () => {
    for (let col = z.left; col <= z.right; col += 1) {
      let widest = 0;
      for (const [row, , content] of sheet.cells.entries({
        top: 0,
        left: col,
        bottom: sheet.rows.count - 1,
        right: col,
      })) {
        if (content.value === null && content.formula === undefined) continue;
        const style = m.style(sheet.id, row, col);
        const type = m.cellType(sheet.id, row, col)?.value;
        if (type?.measure !== undefined) {
          // A typed cell says how wide it wants to be (a checkbox: its square; a link: its text).
          const wanted = type.measure(m.value(sheet.id, row, col), style, (t) => measure(t, style));
          if (wanted !== undefined) widest = Math.max(widest, wanted);
          continue;
        }
        const shown =
          typeof content.value === 'object' && content.value !== null
            ? content.value.error
            : String(content.value ?? '#NAME?');
        widest = Math.max(widest, measure(shown, style));
      }
      if (widest > 0)
        check(
          m.dispatch({
            type: 'RESIZE_AXIS',
            sheet: sheet.id,
            axis: 'cols',
            from: col,
            to: col,
            size: Math.ceil(widest + 10),
          }),
        );
    }
    return { ok: true } as const;
  });
};

/** Whether the last zone spans whole columns (every row), as Ctrl+Space selects. */
function wholeColumns(m: CellsModel): boolean {
  const z = last(m);
  return (
    z.top === 0 &&
    z.bottom === m.sheet(m.selection.sheet).rows.count - 1 &&
    !(z.left === 0 && z.right === m.sheet(m.selection.sheet).cols.count - 1)
  );
}

const deleteLines =
  (axis: 'rows' | 'cols'): Action =>
  ({ model: m }) => {
    const z = last(m);
    const [at, n] =
      axis === 'rows' ? [z.top, z.bottom - z.top + 1] : [z.left, z.right - z.left + 1];
    return check(m.dispatch({ type: 'DELETE_AXIS', sheet: m.selection.sheet, axis, at, n }));
  };

/** Toggle a style flag over the selection, by what the active cell has. */
const toggle =
  (flag: 'bold' | 'italic' | 'underline' | 'strike'): Action =>
  ({ model: m }) => {
    const sel = m.selection;
    const on = !m.style(sel.sheet, sel.active.row, sel.active.col)[flag];
    return m.transact(on ? `Set ${flag}` : `Clear ${flag}`, () => {
      for (const zone of sel.zones)
        check(m.dispatch({ type: 'SET_STYLE', sheet: sel.sheet, zone, style: { [flag]: on } }));
      return { ok: true } as const;
    });
  };

/** Set a number format over the selection. */
const formatAs =
  (format: string): Action =>
  ({ model: m }) => {
    const sel = m.selection;
    return m.transact('Number format', () => {
      for (const zone of sel.zones)
        check(m.dispatch({ type: 'SET_STYLE', sheet: sel.sheet, zone, style: { format } }));
      return { ok: true } as const;
    });
  };

/** The built-in editing commands (bold, insert rows, undo, fit columns, …) as Reactor commands with their keybindings. */
export const EDITING_COMMANDS: readonly CellsCommand[] = [
  command('editCell', 'Edit the cell', editCell, {
    gridKeybindings: ['F2'],
    octicon: 'pencil',
  }),
  command('clearAndEdit', 'Empty the cell and edit it', clearAndEdit, {
    gridKeybindings: ['Backspace'],
  }),
  command('clearContents', 'Clear contents', clearContents, {
    gridKeybindings: ['Delete'],
    octicon: 'trash',
  }),
  command('openContextMenu', 'Open the context menu', openContextMenu, {
    gridKeybindings: ['Shift+F10', 'ContextMenu'],
    octicon: 'kebab-horizontal',
  }),
  command('bold', 'Bold', toggle('bold'), { keybinding: 'Mod+B', octicon: 'bold' }),
  command('italic', 'Italic', toggle('italic'), { keybinding: 'Mod+I', octicon: 'italic' }),
  command('underline', 'Underline', toggle('underline'), { keybinding: 'Mod+U' }),
  command('strikethrough', 'Strikethrough', toggle('strike'), {
    keybinding: 'Mod+5',
    octicon: 'strikethrough',
  }),
  command('formatNumber', 'Format as number', formatAs('#,##0.00'), {
    keybinding: 'Mod+Shift+!',
    octicon: 'number',
  }),
  command('formatCurrency', 'Format as currency', formatAs('$#,##0.00;($#,##0.00)'), {
    keybinding: 'Mod+Shift+$',
  }),
  command('formatPercent', 'Format as percent', formatAs('0%'), { keybinding: 'Mod+Shift+%' }),
  command('formatDate', 'Format as date', formatAs('yyyy-mm-dd'), {
    keybinding: 'Mod+Shift+#',
    octicon: 'calendar',
  }),
  command('formatGeneral', 'Clear the number format', formatAs('General'), {
    keybinding: 'Mod+Shift+~',
  }),
  command(
    'insert',
    'Insert rows above, or columns left of whole columns',
    (a) => (wholeColumns(a.model) ? insertCols(false)(a) : insertRows(false)(a)),
    {
      keybinding: 'Mod+Alt+=',
      octicon: 'plus',
    },
  ),
  command(
    'delete',
    'Delete rows, or whole columns',
    (a) => (wholeColumns(a.model) ? deleteLines('cols')(a) : deleteLines('rows')(a)),
    {
      keybinding: 'Mod+Alt+-',
      octicon: 'dash',
    },
  ),
  command('insertRowsAbove', 'Insert rows above', insertRows(false)),
  command('insertRowsBelow', 'Insert rows below', insertRows(true)),
  command('insertColumnsLeft', 'Insert columns left', insertCols(false)),
  command('insertColumnsRight', 'Insert columns right', insertCols(true)),
  command('deleteRows', 'Delete rows', deleteLines('rows')),
  command('deleteColumns', 'Delete columns', deleteLines('cols')),
  command('moveRowsUp', 'Move rows up', moveAxis('rows', false), {
    keybinding: 'Alt+Shift+ArrowUp',
  }),
  command('moveRowsDown', 'Move rows down', moveAxis('rows', true), {
    keybinding: 'Alt+Shift+ArrowDown',
  }),
  command('moveColumnsLeft', 'Move columns left', moveAxis('cols', false), {
    keybinding: 'Alt+Shift+ArrowLeft',
  }),
  command('moveColumnsRight', 'Move columns right', moveAxis('cols', true), {
    keybinding: 'Alt+Shift+ArrowRight',
  }),
  command('hideRows', 'Hide rows', hide('rows', true), { keybinding: 'Mod+Alt+9' }),
  command('unhideRows', 'Unhide rows', hide('rows', false), { keybinding: 'Mod+Shift+9' }),
  command('hideColumns', 'Hide columns', hide('cols', true), { keybinding: 'Mod+Alt+0' }),
  command('unhideColumns', 'Unhide columns', hide('cols', false), { keybinding: 'Mod+Shift+0' }),
  command('fitColumns', 'Fit columns to their text', fitColumns),
  command('merge', 'Merge cells', ({ model: m }) =>
    check(m.dispatch({ type: 'MERGE', sheet: m.selection.sheet, zone: last(m) })),
  ),
  command('unmerge', 'Unmerge cells', ({ model: m }) =>
    check(m.dispatch({ type: 'UNMERGE', sheet: m.selection.sheet, zone: last(m) })),
  ),
  command('freezeHere', 'Freeze up to the active cell', ({ model: m }) =>
    check(
      m.dispatch({
        type: 'FREEZE',
        sheet: m.selection.sheet,
        rows: m.selection.active.row,
        cols: m.selection.active.col,
      }),
    ),
  ),
  command('unfreeze', 'Unfreeze', ({ model: m }) =>
    check(m.dispatch({ type: 'FREEZE', sheet: m.selection.sheet, rows: 0, cols: 0 })),
  ),
  command('undo', 'Undo', ({ model: m }) => m.undo(), { keybinding: 'Mod+Z', octicon: 'undo' }),
  command('redo', 'Redo', ({ model: m }) => m.redo(), {
    keybinding: 'Mod+Y',
    gridKeybindings: ['Mod+Shift+Z'],
    octicon: 'redo',
  }),
];

/** The context menu's items, in order, with their groups. */
const MENU: readonly (readonly [string, string])[] = [
  ['undo', 'history'],
  ['redo', 'history'],
  ['insertRowsAbove', 'rows'],
  ['insertRowsBelow', 'rows'],
  ['deleteRows', 'rows'],
  ['moveRowsUp', 'rows'],
  ['moveRowsDown', 'rows'],
  ['hideRows', 'rows'],
  ['unhideRows', 'rows'],
  ['insertColumnsLeft', 'columns'],
  ['insertColumnsRight', 'columns'],
  ['deleteColumns', 'columns'],
  ['moveColumnsLeft', 'columns'],
  ['moveColumnsRight', 'columns'],
  ['hideColumns', 'columns'],
  ['unhideColumns', 'columns'],
  ['fitColumns', 'columns'],
  ['merge', 'cells'],
  ['unmerge', 'cells'],
  ['freezeHere', 'view'],
  ['unfreeze', 'view'],
];

/** The toolbar's items, in order, with their groups (`./chrome`'s `<Toolbar>` shows them). */
const TOOLBAR: readonly (readonly [string, string])[] = [
  ['undo', 'history'],
  ['redo', 'history'],
  ['bold', 'text'],
  ['italic', 'text'],
  ['underline', 'text'],
  ['strikethrough', 'text'],
  ['formatNumber', 'number'],
  ['formatCurrency', 'number'],
  ['formatPercent', 'number'],
  ['formatDate', 'number'],
  ['formatGeneral', 'number'],
  ['merge', 'cells'],
  ['unmerge', 'cells'],
  ['freezeHere', 'view'],
  ['unfreeze', 'view'],
];

/** The built-in editing actions: Reactor commands, the context menu's items and the toolbar's. */
export const CellsEditingPlugin = definePlugin({
  name: CELLS_EDITING_PLUGIN,
  displayName: 'Cells editing',
  description:
    'Insert, delete, move, hide, merge and freeze from the keyboard and the context menu.',
  octicon: 'pencil',
  commands: [...EDITING_COMMANDS],
  contributes: [
    ...MENU.map(([id, group], i) =>
      contribution(
        CellsMenuItems,
        { command: `cells.${id}`, group },
        { id: `cells.${id}`, order: 100 + i },
      ),
    ),
    ...TOOLBAR.map(([id, group], i) =>
      contribution(
        CellsToolbarItems,
        { command: `cells.${id}`, group },
        { id: `cells.${id}`, order: 100 + i },
      ),
    ),
  ],
});
