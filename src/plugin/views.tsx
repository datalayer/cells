/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What the plugin draws in a shell: the list of workbooks (with New, rename
 * and delete) and the open workbook, a grid with its chrome.
 *
 * @module plugin/views
 */

import { useContributions, useReactorPlatform } from '@datalayer/reactor/react';
import { PencilIcon, PlusIcon, TrashIcon } from '@primer/octicons-react';
import { ActionList, Button, IconButton, TextInput } from '@primer/react';
import { type JSX, useEffect, useState } from 'react';
import { FormulaBar } from '../chrome/FormulaBar.js';
import { SheetTabs } from '../chrome/SheetTabs.js';
import { Toolbar } from '../chrome/Toolbar.js';
import { CellsProvider } from '../react/hooks.js';
import { Spreadsheet } from '../react/Spreadsheet.js';
import { WorkbookCatalog } from './points.js';
import {
  createWorkbook,
  openWorkbook,
  registerWorkbooks,
  removeWorkbook,
  renameWorkbook,
  useWorkbooksState,
  type WorkbookEntry,
  workbookModel,
} from './store.js';

/** Workbooks other plugins contribute, in the catalog while their plugin is on. */
function useContributedWorkbooks(): void {
  const contributed = useContributions(WorkbookCatalog);
  useEffect(
    () =>
      registerWorkbooks(
        contributed.map((c) => c.value as WorkbookEntry),
        'contributed',
      ),
    [contributed],
  );
}

/** The shell's workbook list (new, rename, delete) for the sidebar slot. */
export function WorkbookList(): JSX.Element {
  useContributedWorkbooks();
  const { workbooks, open } = useWorkbooksState();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  return (
    <nav aria-label="Workbooks" data-cells-workbook-list="">
      <Button leadingVisual={PlusIcon} size="small" onClick={() => createWorkbook()}>
        New workbook
      </Button>
      <ActionList>
        {workbooks.map((w) =>
          renaming?.id === w.id ? (
            <li key={w.id}>
              <TextInput
                aria-label={`Rename ${w.title}`}
                size="small"
                autoFocus
                value={renaming.title}
                onChange={(e) => setRenaming({ id: w.id, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    renameWorkbook(w.id, renaming.title);
                    setRenaming(null);
                  } else if (e.key === 'Escape') setRenaming(null);
                }}
              />
            </li>
          ) : (
            <ActionList.Item key={w.id} active={w.id === open} onSelect={() => openWorkbook(w.id)}>
              {w.title}
              <ActionList.TrailingVisual>
                <IconButton
                  icon={PencilIcon}
                  aria-label={`Rename ${w.title}`}
                  size="small"
                  variant="invisible"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    setRenaming({ id: w.id, title: w.title });
                  }}
                />
                <IconButton
                  icon={TrashIcon}
                  aria-label={`Delete ${w.title}`}
                  size="small"
                  variant="invisible"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    removeWorkbook(w.id);
                  }}
                />
              </ActionList.TrailingVisual>
            </ActionList.Item>
          ),
        )}
      </ActionList>
    </nav>
  );
}

/** The open workbook in a shell's main slot, with its toolbar, formula bar and sheet tabs. */
export function WorkbookView(): JSX.Element {
  const platform = useReactorPlatform();
  const { workbooks, open } = useWorkbooksState();
  const entry = workbooks.find((w) => w.id === open);
  if (entry === undefined)
    return (
      <div data-cells-workbook-view="">
        <p>No workbook is open.</p>
        <Button leadingVisual={PlusIcon} onClick={() => createWorkbook()}>
          New workbook
        </Button>
      </div>
    );
  const model = workbookModel(entry.id, platform);
  return (
    <div
      data-cells-workbook-view=""
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320 }}
    >
      <CellsProvider model={model}>
        <Toolbar />
        <FormulaBar />
        <div style={{ flex: 1, minHeight: 240, position: 'relative' }}>
          <Spreadsheet key={entry.id} model={model} aria-label={entry.title} />
        </div>
        <SheetTabs />
      </CellsProvider>
    </div>
  );
}
