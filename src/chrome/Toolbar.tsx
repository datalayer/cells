/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The toolbar: the Reactor commands that plugins contribute to
 * `datalayer.cells.toolbarItem`, in their groups and `order`, as Primer
 * buttons. One tab stop, the arrow keys move between the buttons (the WAI-ARIA
 * toolbar pattern); each button is named by its command and its shortcut, and
 * the text-style buttons say whether the active cell has the style.
 *
 * @module chrome/Toolbar
 */

import { formatKeybinding, type ReactorCommand } from '@datalayer/reactor';
import {
  BoldIcon,
  CalendarIcon,
  type Icon,
  ItalicIcon,
  LockIcon,
  NumberIcon,
  RedoIcon,
  SortAscIcon,
  SortDescIcon,
  StrikethroughIcon,
  TableIcon,
  UndoIcon,
  UnlockIcon,
} from '@primer/octicons-react';
import { Button, IconButton } from '@primer/react';
import { type KeyboardEvent, useCallback, useRef, useState } from 'react';
import { CellsToolbarItems } from '../points/index.js';
import { ChartTypePicker } from './ChartTypePicker.js';
import type { Style } from '../core/styles.js';
import {
  useCells,
  useCellsCommands,
  useContributions,
  useSelection,
  useStyle,
} from '../react/hooks.js';
import { columnLetters } from '../core/zone.js';

/** The octicons a command may name, by name. */
const ICONS: Record<string, Icon> = {
  bold: BoldIcon,
  italic: ItalicIcon,
  strikethrough: StrikethroughIcon,
  undo: UndoIcon,
  redo: RedoIcon,
  'sort-asc': SortAscIcon,
  'sort-desc': SortDescIcon,
  number: NumberIcon,
  calendar: CalendarIcon,
  table: TableIcon,
  lock: LockIcon,
  unlock: UnlockIcon,
};

/** The text-style commands, and the style they toggle: their buttons are pressed when the cell has it. */
const PRESSED: Record<string, keyof Style> = {
  'cells.bold': 'bold',
  'cells.italic': 'italic',
  'cells.underline': 'underline',
  'cells.strikethrough': 'strike',
};

export interface ToolbarProps {
  readonly 'aria-label'?: string;
  /** Told when a command fails, with its message (the grid announces it too). */
  readonly onError?: (message: string) => void;
  /** The *Insert chart* picker at the end of the toolbar; on by default. */
  readonly charts?: boolean;
}

export function Toolbar(props: ToolbarProps) {
  const model = useCells();
  const items = useContributions(CellsToolbarItems);
  const commands = useCellsCommands() as readonly ReactorCommand<unknown, unknown>[];
  const selection = useSelection();
  const active = `${columnLetters(selection.active.col)}${selection.active.row + 1}`;
  const { style } = useStyle(
    `'${model.sheet(selection.sheet).name.replace(/'/g, "''")}'!${active}`,
  );
  const [focused, setFocused] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const byId = new Map(commands.map((c) => [c.id, c]));
  // Items naming a command no plugin provides are left out: their plugin is off.
  const shown = items.filter((i) => byId.has(i.value.command));
  const groups: (typeof shown)[] = [];
  for (const item of shown) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0].value.group === item.value.group) last.push(item);
    else groups.push([item]);
  }

  const run = useCallback(
    (id: string) => {
      model.reactor
        .executeCommand(id, { model })
        .catch((error: Error) => props.onError?.(error.message));
    },
    [model, props],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const n = shown.length;
    if (n === 0) return;
    const next =
      e.key === 'ArrowRight'
        ? (focused + 1) % n
        : e.key === 'ArrowLeft'
          ? (focused + n - 1) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setFocused(next);
    buttons.current[next]?.focus();
  };

  let index = -1;
  return (
    <div
      role="toolbar"
      aria-label={props['aria-label'] ?? 'Spreadsheet toolbar'}
      onKeyDown={onKeyDown}
      data-cells-toolbar=""
      style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', padding: 4 }}
    >
      {groups.map((group, g) => (
        <div
          key={g}
          role="group"
          aria-label={group[0].value.group}
          style={{
            display: 'flex',
            gap: 2,
            paddingInlineEnd: 4,
            borderInlineEnd:
              g < groups.length - 1 ? '1px solid var(--borderColor-muted, #d0d7de)' : undefined,
          }}
        >
          {group.map((item) => {
            index += 1;
            const i = index;
            const command = byId.get(item.value.command)!;
            const binding = typeof command.keybinding === 'string' ? command.keybinding : undefined;
            const label = binding ? `${command.name} (${formatKeybinding(binding)})` : command.name;
            const icon = typeof command.octicon === 'string' ? ICONS[command.octicon] : undefined;
            const key = PRESSED[command.id];
            const common = {
              ref: (el: HTMLButtonElement | null) => {
                buttons.current[i] = el;
              },
              tabIndex: i === focused ? 0 : -1,
              onFocus: () => setFocused(i),
              onClick: () => run(command.id),
              'aria-pressed': key === undefined ? undefined : style[key] === true,
              'data-command': command.id,
            };
            return icon !== undefined ? (
              <IconButton
                key={item.id}
                {...common}
                icon={icon}
                aria-label={label}
                size="small"
                variant="invisible"
              />
            ) : (
              <Button key={item.id} {...common} aria-label={label} size="small" variant="invisible">
                {command.name}
              </Button>
            );
          })}
        </div>
      ))}
      {props.charts !== false && (
        <div role="group" aria-label="charts" data-cells-toolbar-group="charts">
          <ChartTypePicker onError={props.onError} />
        </div>
      )}
    </div>
  );
}
