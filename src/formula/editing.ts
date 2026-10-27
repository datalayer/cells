/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * What editing a formula needs, on the text and the caret only: whether the
 * caret is where a reference can be pointed at, the references of the text
 * (to colour them on the grid), `$` anchors toggled with F4, the function name
 * being typed (for autocomplete), and the call and argument the caret is in
 * (for argument hints).
 *
 * @module formula/editing
 */

import { columnLetters } from '../core/zone.js';
import { tokenize, type Token } from './tokens.js';

/** Whether a text is a formula being typed. */
export const isFormulaText = (text: string) => text.startsWith('=');

/** Tokens of a formula's body (after the `=`), positions in the whole text. */
function tokensOf(text: string): Token[] {
  return tokenize(text.slice(1)).map((t) => ({ ...t, start: t.start + 1, end: t.end + 1 }));
}

/**
 * Whether the caret is where a reference may be inserted by pointing: right
 * after the `=`, an opening parenthesis, an argument separator or an operator
 * (spaces between are allowed).
 */
export function canPoint(text: string, caret: number): boolean {
  if (!isFormulaText(text) || caret < 1) return false;
  let i = caret - 1;
  while (i > 0 && text[i] === ' ') i -= 1;
  if (i === 0) return true;
  const before = tokensOf(text).filter((t) => t.end <= i + 1 && t.kind !== 'whitespace');
  const last = before[before.length - 1];
  if (last === undefined) return true;
  return (
    last.kind === 'lparen' ||
    last.kind === 'separator' ||
    last.kind === 'lbrace' ||
    (last.kind === 'operator' && last.text !== '%')
  );
}

/** A reference as text: `B3`, `B2:B9`, `Sheet2!A1` (quoted when it must be). */
export function referenceText(
  from: { row: number; col: number },
  to: { row: number; col: number },
  sheetName?: string,
): string {
  const top = Math.min(from.row, to.row);
  const bottom = Math.max(from.row, to.row);
  const left = Math.min(from.col, to.col);
  const right = Math.max(from.col, to.col);
  const a = `${columnLetters(left)}${top + 1}`;
  const b = `${columnLetters(right)}${bottom + 1}`;
  const sheet =
    sheetName === undefined
      ? ''
      : /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName) && !/^[A-Za-z]{1,3}[0-9]+$/.test(sheetName)
        ? `${sheetName}!`
        : `'${sheetName.replace(/'/g, "''")}'!`;
  return sheet + (a === b ? a : `${a}:${b}`);
}

/** A reference in a formula's text: where it is, and the cells it names (whole rows and columns open-ended). */
export interface TextReference {
  readonly start: number;
  readonly end: number;
  readonly sheet?: string;
  readonly top?: number;
  readonly left?: number;
  readonly bottom?: number;
  readonly right?: number;
}

function part(text: string): { row?: number; col?: number } {
  const m = /^\$?([A-Za-z]{1,3})?\$?([0-9]{1,7})?$/.exec(text);
  if (m === null) return {};
  let col: number | undefined;
  if (m[1] !== undefined) {
    col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    col -= 1;
  }
  return { col, row: m[2] === undefined ? undefined : Number(m[2]) - 1 };
}

/** The references of a formula's text, in order: what the grid outlines in colour while editing. */
export function referencesIn(text: string): TextReference[] {
  if (!isFormulaText(text)) return [];
  const tokens = tokensOf(text);
  const out: TextReference[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let t = tokens[i];
    let sheet: string | undefined;
    let start = t.start;
    if (t.kind === 'sheet') {
      const raw = t.text.slice(0, -1);
      sheet = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
      i += 1;
      t = tokens[i];
      if (t === undefined || t.kind !== 'ref') continue;
    } else start = t.start;
    if (t.kind !== 'ref') continue;
    const from = part(t.text);
    let to = from;
    let end = t.end;
    if (
      tokens[i + 1]?.kind === 'operator' &&
      tokens[i + 1].text === ':' &&
      tokens[i + 2]?.kind === 'ref'
    ) {
      to = part(tokens[i + 2].text);
      end = tokens[i + 2].end;
      i += 2;
    }
    const rows = [from.row, to.row].filter((x): x is number => x !== undefined);
    const cols = [from.col, to.col].filter((x): x is number => x !== undefined);
    out.push({
      start,
      end,
      ...(sheet !== undefined ? { sheet } : {}),
      ...(rows.length > 0 ? { top: Math.min(...rows), bottom: Math.max(...rows) } : {}),
      ...(cols.length > 0 ? { left: Math.min(...cols), right: Math.max(...cols) } : {}),
    });
  }
  return out;
}

const ANCHORS = [
  (c: string, r: string) => `$${c}$${r}`,
  (c: string, r: string) => `${c}$${r}`,
  (c: string, r: string) => `$${c}${r}`,
  (c: string, r: string) => `${c}${r}`,
];

/**
 * F4 while editing: the cell reference at (or just before) the caret cycles
 * through `$A$1`, `A$1`, `$A1`, `A1`; for a range, both ends together.
 * `undefined` when the caret is on no reference.
 */
export function toggleAnchors(
  text: string,
  caret: number,
): { text: string; caret: number } | undefined {
  const ref = referencesIn(text).find((r) => caret >= r.start && caret <= r.end);
  if (ref === undefined) return undefined;
  const body = text.slice(ref.start, ref.end);
  const bang = body.lastIndexOf('!');
  const prefix = bang >= 0 ? body.slice(0, bang + 1) : '';
  const ends = body.slice(prefix.length).split(':');
  const cells = ends.map((e) => /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/.exec(e));
  if (cells.some((m) => m === null)) return undefined;
  const first = cells[0]!;
  const state = (first[1] ? 2 : 0) + (first[3] ? 1 : 0); // 3 $A$1, 1 A$1, 2 $A1, 0 A1
  const next = { 3: 1, 1: 2, 2: 0, 0: 3 }[state] as 0 | 1 | 2 | 3;
  const write = ANCHORS[{ 3: 0, 1: 1, 2: 2, 0: 3 }[next]];
  const replaced = prefix + cells.map((m) => write(m![2], m![4])).join(':');
  return {
    text: text.slice(0, ref.start) + replaced + text.slice(ref.end),
    caret: ref.start + replaced.length,
  };
}

/** The function name being typed at the caret (letters right before it, where a function may start), or `undefined`. */
export function namePrefix(
  text: string,
  caret: number,
): { start: number; prefix: string } | undefined {
  if (!isFormulaText(text)) return undefined;
  let i = caret;
  while (i > 1 && /[A-Za-z0-9_.]/.test(text[i - 1])) i -= 1;
  const prefix = text.slice(i, caret);
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(prefix)) return undefined;
  if (text[caret] === '(') return undefined;
  if (!canPoint(text, i)) return undefined;
  return { start: i, prefix };
}

/** The innermost call the caret is inside, and which of its arguments (0 for the first). */
export function callAt(
  text: string,
  caret: number,
): { name: string; argument: number } | undefined {
  if (!isFormulaText(text)) return undefined;
  const stack: { name?: string; argument: number }[] = [];
  let previous: Token | undefined;
  for (const t of tokensOf(text)) {
    if (t.start >= caret) break;
    if (t.kind === 'lparen') {
      stack.push({
        name: previous?.kind === 'function' ? previous.text.toUpperCase() : undefined,
        argument: 0,
      });
    } else if (t.kind === 'rparen') {
      stack.pop();
    } else if (t.kind === 'separator') {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.argument += 1;
    }
    if (t.kind !== 'whitespace') previous = t;
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const s = stack[i];
    if (s.name !== undefined) return { name: s.name, argument: s.argument };
  }
  return undefined;
}
