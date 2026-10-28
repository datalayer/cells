/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Navigation keys, as Excel and Sheets bind them, read as a `Navigation`.
 * The grid itself binds them through the Reactor commands of
 * `CellsNavigationPlugin` (`cells.moveDown`, `cells.selectAll`, …), whose
 * grid keys belong to its focus target, so two grids on a page never hear
 * each other; this reading stays for hosts that map keys themselves.
 *
 * @module react/keys
 */

import type { Navigation } from '../core/selection.js';

export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

const ARROWS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
} as const;

/** The navigation a key means, or `undefined` when it is not a navigation key. `pageRows`: rows a page holds. */
export function navigationFor(e: KeyLike, pageRows: number): Navigation | undefined {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey) return undefined;
  if (e.key in ARROWS) {
    return {
      type: 'move',
      dir: ARROWS[e.key as keyof typeof ARROWS],
      jump: mod,
      extend: e.shiftKey,
    };
  }
  switch (e.key) {
    case 'Enter':
      return mod ? undefined : { type: 'cycle', by: 'col', reverse: e.shiftKey };
    case 'Tab':
      return mod ? undefined : { type: 'cycle', by: 'row', reverse: e.shiftKey };
    case 'Home':
      return { type: 'home', ctrl: mod, extend: e.shiftKey };
    case 'End':
      return mod ? { type: 'end', extend: e.shiftKey } : undefined;
    case 'PageDown':
      return { type: 'page', dir: 'down', rows: pageRows, extend: e.shiftKey };
    case 'PageUp':
      return { type: 'page', dir: 'up', rows: pageRows, extend: e.shiftKey };
    case ' ':
      if (mod && !e.shiftKey) return { type: 'selectColumns' };
      if (e.shiftKey && !mod) return { type: 'selectRows' };
      return undefined;
    case 'a':
    case 'A':
      return mod && !e.shiftKey ? { type: 'selectAll' } : undefined;
    default:
      return undefined;
  }
}
