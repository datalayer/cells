/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What the polite live region says after a change: a sentence per command,
 * from a table a host can translate (`messages` prop).
 *
 * @module react/messages
 */

import type { Transaction } from '../core/model.js';
import { toA1, zoneToA1 } from '../core/zone.js';

import type { CoreCommand } from '../core/commands.js';

/** A sentence per command type; a command is passed as it was dispatched. */
export type Messages = Readonly<Record<string, (command: { readonly type: string }) => string>>;

type Of<T extends CoreCommand['type']> = Extract<CoreCommand, { type: T }>;
/** A message for one core command type, typed by it. */
const say =
  <T extends CoreCommand['type']>(_type: T, f: (c: Of<T>) => string) =>
  (c: { readonly type: string }) =>
    f(c as Of<T>);

const axisWord = (c: { axis: string; n?: number }) =>
  c.axis === 'rows' ? (c.n === 1 ? 'row' : 'rows') : c.n === 1 ? 'column' : 'columns';

export const MESSAGES: Messages = {
  SET_CELLS: say('SET_CELLS', (c) => `Edited ${toA1(c.at)}`),
  SET_STYLE: say('SET_STYLE', (c) => `Formatted ${zoneToA1(c.zone)}`),
  CLEAR: say('CLEAR', (c) => `Cleared ${zoneToA1(c.zone)}`),
  INSERT_AXIS: say('INSERT_AXIS', (c) => `Inserted ${c.n} ${axisWord(c)} at ${c.at + 1}`),
  DELETE_AXIS: say('DELETE_AXIS', (c) => `Deleted ${c.n} ${axisWord(c)} at ${c.at + 1}`),
  MOVE_AXIS: say('MOVE_AXIS', (c) => `Moved ${c.n} ${axisWord(c)}`),
  RESIZE_AXIS: say(
    'RESIZE_AXIS',
    (c) => `Resized ${axisWord({ axis: c.axis, n: c.to - c.from + 1 })}`,
  ),
  HIDE_AXIS: say(
    'HIDE_AXIS',
    (c) => `${c.hidden ? 'Hid' : 'Showed'} ${axisWord({ axis: c.axis, n: c.to - c.from + 1 })}`,
  ),
  MERGE: say('MERGE', (c) => `Merged ${zoneToA1(c.zone)}`),
  UNMERGE: say('UNMERGE', (c) => `Unmerged ${zoneToA1(c.zone)}`),
  ADD_SHEET: say('ADD_SHEET', (c) => `Added sheet ${c.name ?? ''}`.trim()),
  DELETE_SHEET: say('DELETE_SHEET', () => 'Deleted a sheet'),
  RENAME_SHEET: say('RENAME_SHEET', (c) => `Renamed the sheet to ${c.name}`),
  MOVE_SHEET: say('MOVE_SHEET', () => 'Moved a sheet'),
  FREEZE: say('FREEZE', (c) => `Froze ${c.rows} rows and ${c.cols} columns`),
};

/** The sentence for a transaction; a plugin's command without a message says its label. */
export function announce(tx: Transaction, messages: Messages = MESSAGES): string {
  const human = tx.label.toLowerCase().replace(/_/g, ' ');
  if (tx.origin === 'undo') return `Undo: ${human}`;
  if (tx.origin === 'redo') return `Redo: ${human}`;
  if (tx.commands.length === 1) {
    const say = messages[tx.commands[0].type];
    if (say) return say(tx.commands[0] as never);
  }
  return tx.label;
}
