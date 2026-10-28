/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The sheet tabs: one tab per sheet (a tab list; the arrow keys move between
 * them and show the sheet), a button to add a sheet, and a menu to rename,
 * move and delete the sheet shown (the tab list holds tabs only). Double-click or F2 renames in place; a refused
 * name is said beside the tab.
 *
 * @module chrome/SheetTabs
 */

import { KebabHorizontalIcon, PlusIcon } from '@primer/octicons-react';
import { ActionList, ActionMenu, IconButton, TextInput } from '@primer/react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useSheets } from '../react/hooks.js';

export interface SheetTabsProps {
  readonly 'aria-label'?: string;
}

export function SheetTabs(props: SheetTabsProps) {
  const { sheets, active, add, rename, move, remove, activate } = useSheets();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const tabs = useRef(new Map<string, HTMLButtonElement | null>());

  const commitRename = () => {
    if (renaming === null) return;
    const result = rename(renaming.id, renaming.name.trim());
    if (result.ok) {
      setRenaming(null);
      setError('');
    } else setError(result.refusals.map((r) => r.message).join(' '));
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const n = sheets.length;
    const to =
      e.key === 'ArrowRight'
        ? (index + 1) % n
        : e.key === 'ArrowLeft'
          ? (index + n - 1) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : undefined;
    if (to !== undefined) {
      e.preventDefault();
      activate(sheets[to].id);
      tabs.current.get(sheets[to].id)?.focus();
    } else if (e.key === 'F2') {
      e.preventDefault();
      setRenaming({ id: sheets[index].id, name: sheets[index].name });
    }
  };

  const index = sheets.findIndex((s) => s.id === active);
  const current = sheets[index];
  return (
    <div
      data-cells-sheet-tabs=""
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 4 }}
    >
      <div
        role="tablist"
        aria-label={props['aria-label'] ?? 'Sheets'}
        style={{ display: 'flex', gap: 2 }}
      >
        {sheets.map((s, i) => {
          const selected = s.id === active;
          return (
            <button
              key={s.id}
              ref={(el) => {
                tabs.current.set(s.id, el);
              }}
              role="tab"
              type="button"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => activate(s.id)}
              onDoubleClick={() => setRenaming({ id: s.id, name: s.name })}
              onKeyDown={(e) => onKeyDown(e, i)}
              style={{
                padding: '2px 10px',
                border: '1px solid var(--borderColor-muted, #d0d7de)',
                borderBottom: selected
                  ? '2px solid var(--borderColor-accent-emphasis, #0969da)'
                  : undefined,
                background: selected
                  ? 'var(--bgColor-default, #fff)'
                  : 'var(--bgColor-muted, #f6f8fa)',
                color: 'var(--fgColor-default, #1f2328)',
                fontWeight: selected ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {s.name}
            </button>
          );
        })}
      </div>
      {renaming !== null && (
        <TextInput
          aria-label={`Rename ${sheets.find((s) => s.id === renaming.id)?.name ?? ''}`}
          size="small"
          autoFocus
          value={renaming.name}
          onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              setRenaming(null);
              setError('');
            }
          }}
        />
      )}
      <IconButton
        icon={PlusIcon}
        aria-label="Add a sheet"
        size="small"
        variant="invisible"
        onClick={() => {
          const r = add();
          if (!r.ok) setError(r.refusals.map((x) => x.message).join(' '));
        }}
      />
      {current !== undefined && (
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton
              icon={KebabHorizontalIcon}
              aria-label={`More for ${current.name}`}
              size="small"
              variant="invisible"
            />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              <ActionList.Item onSelect={() => setRenaming({ id: current.id, name: current.name })}>
                Rename
              </ActionList.Item>
              <ActionList.Item disabled={index === 0} onSelect={() => move(current.id, index - 1)}>
                Move left
              </ActionList.Item>
              <ActionList.Item
                disabled={index === sheets.length - 1}
                onSelect={() => move(current.id, index + 1)}
              >
                Move right
              </ActionList.Item>
              <ActionList.Divider />
              <ActionList.Item
                variant="danger"
                disabled={sheets.length === 1}
                onSelect={() => {
                  const r = remove(current.id);
                  if (!r.ok) setError(r.refusals.map((x) => x.message).join(' '));
                }}
              >
                Delete
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      )}
      {error && (
        <span role="alert" style={{ color: 'var(--fgColor-danger, #d1242f)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
