/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The point the shell plugin opens, and the shell's own it joins.
 *
 * @module plugin/points
 */

import { defineContributionPoint } from '@datalayer/reactor';
import type { WorkbookEntry } from './store.js';

/** Where other plugins hand in workbooks: listed while their plugin is on. */
export const WorkbookCatalog = defineContributionPoint<WorkbookEntry>('datalayer.cells.catalog');

/**
 * The Reactor shell's view point, by id (`reactor.shell.view`): the plugin
 * contributes a "Spreadsheets" view without depending on the shell package.
 */
export const ShellView = defineContributionPoint<{ id: string; title: string; order?: number }>(
  'reactor.shell.view',
);
