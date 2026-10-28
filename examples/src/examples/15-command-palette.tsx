/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { formatKeybinding, type RegisteredCommand } from '@datalayer/reactor';
import { ReactorSlot, useReactor } from '@datalayer/reactor/react';
import {
  COMMANDS_TABLE_SLOT,
  CommandsPlugin,
  commandsTablePlugin,
  PALETTE_KEYBINDING,
} from '@datalayer/reactor-commands';
import {
  buildCellsReactor,
  type CellsCommand,
  type CellsModel,
  createCellsModel,
  fromRows,
  Spreadsheet,
} from '@datalayer/cells';
import { useState } from 'react';
import { Frame } from '../shared';

/** A grid on a Reactor platform that also runs the command palette plugin. */
export function paletteModel(): CellsModel {
  const reactor = buildCellsReactor([
    CommandsPlugin,
    // The Cells commands in a Primer table, their grid keys beside their keybinding.
    commandsTablePlugin({
      category: 'Cells',
      title: 'The Cells commands the palette offers',
      subtitle:
        'Each is a Reactor command: the palette runs it on the grid that last had the focus.',
      extraKeys: gridKeysOf,
    }),
  ]);
  return createCellsModel({
    reactor,
    data: fromRows([
      ['Region', 'Q1', 'Q2', 'Q3', 'Q4'],
      ['North', 120, 135, 160, 150],
      ['South', 90, 110, 105, 130],
      ['East', 70, 65, 80, 95],
      ['West', 140, 150, 170, 165],
    ]),
  });
}

/** The keys a Cells command answers to on the grid, besides its Reactor keybinding. */
export function gridKeysOf(command: RegisteredCommand): readonly string[] {
  return (command as CellsCommand).gridKeybindings ?? [];
}

/** The keys a Cells command answers to, as this platform writes them. */
export function keysOf(command: RegisteredCommand): string {
  const all = [
    ...(command.keybinding !== undefined ? [command.keybinding] : []),
    ...gridKeysOf(command),
  ];
  return all.map((k) => formatKeybinding(k)).join(', ');
}

/**
 * The Reactor command palette (`@datalayer/reactor-commands`) over a grid:
 * every Cells shortcut is a Reactor command, so the palette lists them all
 * and runs the chosen one on the grid that last had the focus. A test hands
 * in its own `model` (made by `paletteModel`) to read what a command did.
 */
export default function CommandPaletteExample(props: { readonly model?: CellsModel }) {
  const [model] = useState(() => props.model ?? paletteModel());
  // The platform is published for the palette (it reads the commands from it); the grid started it.
  useReactor(model.reactor, { autoStart: false });
  return (
    <>
      <p>
        Press <kbd data-palette-shortcut="">{formatKeybinding(PALETTE_KEYBINDING)}</kbd> to open the
        command palette, type to filter, Enter to run. A command runs on the grid; the palette also
        binds each command&apos;s Reactor keybinding on the whole page while it is mounted, and the
        grid keys (arrows, Enter, Delete, …) stay the grid&apos;s own.
      </p>
      <Frame height={220}>
        <Spreadsheet model={model} aria-label="Quarterly sales" />
      </Frame>
      {/* The palette is a plugin component in the `root` slot: it portals itself to the page. */}
      <ReactorSlot slot="root" />
      {/* The commands table, a Reactor plugin of @datalayer/reactor-commands: Primer's DataTable and KeybindingHint. */}
      <ReactorSlot slot={COMMANDS_TABLE_SLOT} />
    </>
  );
}
