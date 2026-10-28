/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The formula bar: the name box (the active cell or range; type a reference
 * and Enter to go there) and the formula input, which shares the in-cell
 * editor's buffer: editing in one shows in the other. Enter commits, Escape
 * cancels; a refused commit is said beside the input.
 *
 * @module chrome/FormulaBar
 */

import { TextInput } from '@primer/react';
import { useEffect, useId, useState } from 'react';
import { isCellError } from '../core/values.js';
import { columnLetters, zoneToA1 } from '../core/zone.js';
import { numberToText } from '../formula/values.js';
import { useCell, useCells, useCellsEditor, useSelection } from '../react/hooks.js';

/** The props of `<FormulaBar>`. */
export interface FormulaBarProps {
  readonly 'aria-label'?: string;
}

/** The name box and the formula input, sharing the in-cell editor's buffer. */
export function FormulaBar(props: FormulaBarProps) {
  const model = useCells();
  const selection = useSelection();
  const editor = useCellsEditor();
  const sheetName = model.sheet(selection.sheet).name;
  const quoted = `'${sheetName.replace(/'/g, "''")}'`;
  const active = `${columnLetters(selection.active.col)}${selection.active.row + 1}`;
  const { content, value } = useCell(`${quoted}!${active}`);
  const zone = selection.zones[selection.zones.length - 1];
  const where = zone.top === zone.bottom && zone.left === zone.right ? active : zoneToA1(zone);
  const [name, setName] = useState(where);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();
  useEffect(() => {
    if (!naming) setName(where);
  }, [where, naming]);

  const editing =
    editor.edit !== null &&
    editor.edit.sheet === selection.sheet &&
    editor.edit.row === selection.active.row &&
    editor.edit.col === selection.active.col;
  const shown = editing
    ? editor.edit!.text
    : content?.formula !== undefined
      ? `=${content.formula}`
      : value === null
        ? ''
        : typeof value === 'number'
          ? numberToText(value)
          : typeof value === 'boolean'
            ? value
              ? 'TRUE'
              : 'FALSE'
            : isCellError(value)
              ? value.error
              : value;

  return (
    <div
      role="group"
      aria-label={props['aria-label'] ?? 'Formula bar'}
      data-cells-formula-bar=""
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 4 }}
    >
      <TextInput
        aria-label="Name box"
        size="small"
        value={name}
        style={{ width: 96 }}
        onFocus={() => setNaming(true)}
        onBlur={() => setNaming(false)}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            try {
              selection.select(name.trim());
              setError('');
              setNaming(false);
            } catch (x) {
              setError((x as Error).message);
            }
          } else if (e.key === 'Escape') {
            setName(where);
            setError('');
          }
        }}
      />
      <span aria-hidden="true" style={{ fontStyle: 'italic', opacity: 0.7 }}>
        fx
      </span>
      <TextInput
        aria-label="Formula"
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        size="small"
        block
        value={shown}
        onFocus={() => {
          if (!editing) editor.start();
        }}
        onChange={(e) => {
          if (!editing) editor.start();
          editor.setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const result = editor.commit();
            setError(result.ok ? '' : result.refusals.map((r) => r.message).join(' '));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            editor.cancel();
            setError('');
          }
        }}
      />
      {error && (
        <span id={errorId} role="alert" style={{ color: 'var(--fgColor-danger, #d1242f)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
