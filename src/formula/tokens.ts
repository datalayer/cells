/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The formula tokenizer: a formula's text (without its `=`) as tokens with
 * their positions, which the parser reads and the editor colours. Unknown
 * characters become `unknown` tokens rather than errors here; the parser
 * refuses them with their position.
 *
 * @module formula/tokens
 */

export type TokenKind =
  | 'number'
  | 'string'
  | 'bool'
  | 'error'
  /** A cell (`B3`, `$B$3`), a column (`B`) or a row (`3`) part of a reference; a sheet prefix is `sheet`. */
  | 'ref'
  | 'sheet'
  | 'function'
  | 'name'
  | 'operator'
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace'
  | 'separator'
  | 'arraySeparator'
  | 'whitespace'
  | 'unknown';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Offsets in the formula text, `[start, end)`. */
  readonly start: number;
  readonly end: number;
}

/** Locale separators: `,` and `.` in en-US; `;` and `,` where the comma is the decimal mark. */
export interface FormulaSyntax {
  readonly argumentSeparator: ',' | ';';
  readonly decimal: '.' | ',';
  /** Separates the columns of an array literal (`{1,2;3,4}` in en-US). */
  readonly arrayColumn: ',' | '\\' | '.';
}

export const EN_US_SYNTAX: FormulaSyntax = {
  argumentSeparator: ',',
  decimal: '.',
  arrayColumn: ',',
};

const ERRORS = [
  '#DIV/0!',
  '#REF!',
  '#NAME?',
  '#VALUE!',
  '#N/A',
  '#NUM!',
  '#NULL!',
  '#CYCLE!',
  '#BUSY!',
  '#SPILL!',
  '#GETTING_DATA',
];
const OPERATORS = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%', ':'];

/** A cell reference's shape: `$A$1`, `A1`, `$A`, `1`. Sticky: matched where the tokenizer stands. */
const CELL = /\$?[A-Za-z]{1,3}\$?[0-9]{1,7}/y;
const COLUMN = /\$?[A-Za-z]{1,3}(?=\s*:)/y;
const NUMBER_DOT = /[0-9]*(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?/y;
const NUMBER_COMMA = /[0-9]*(?:,[0-9]*)?(?:[eE][+-]?[0-9]+)?/y;
const ROW = /\$?[0-9]{1,7}(?=\s*:)/y;
const ROW_AFTER_COLON = /\$?[0-9]{1,7}(?![0-9.eE%A-Za-z(])/y;
const ABS_ROW = /\$[0-9]{1,7}/y;
const WORD = /[A-Za-z_\\][A-Za-z0-9_.\\]*/y;
const COLUMN_AFTER_COLON = /\$?[A-Za-z]{1,3}(?![A-Za-z0-9_(])/y;

/** The length of what a sticky pattern matches at `i`, or -1. */
function match(re: RegExp, text: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(text);
  return m === null ? -1 : m[0].length;
}

const isSpace = (ch: string | undefined) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || (ch !== undefined && /\s/.test(ch));
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';
const isLetter = (ch: string) =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '\\';

export function tokenize(text: string, syntax: FormulaSyntax = EN_US_SYNTAX): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, end: number) => {
    tokens.push({ kind, text: text.slice(i, end), start: i, end });
    i = end;
  };
  /** Whether the previous meaningful token ends an operand (so `:` after it is a range, a number after `:` a row). */
  const afterColon = () => {
    for (let k = tokens.length - 1; k >= 0; k -= 1) {
      if (tokens[k].kind === 'whitespace') continue;
      return tokens[k].kind === 'operator' && tokens[k].text === ':';
    }
    return false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (isSpace(ch)) {
      let j = i + 1;
      while (j < text.length && isSpace(text[j])) j += 1;
      push('whitespace', j);
    } else if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) break;
        if (text[j] === '"') {
          if (text[j + 1] === '"') j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      push('string', j);
    } else if (ch === "'") {
      // A quoted sheet name: 'My sheet'!A1.
      let j = i + 1;
      for (;;) {
        if (j >= text.length) break;
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      if (text[j] === '!') push('sheet', j + 1);
      else push('unknown', j);
    } else if (ch === '#') {
      const error = ERRORS.find((e) => text.slice(i, i + e.length).toUpperCase() === e);
      if (error) push('error', i + error.length);
      else push('unknown', i + 1);
    } else if (ch === '(') push('lparen', i + 1);
    else if (ch === ')') push('rparen', i + 1);
    else if (ch === '{') push('lbrace', i + 1);
    else if (ch === '}') push('rbrace', i + 1);
    else if (ch === syntax.argumentSeparator) {
      // Inside braces, the argument separator separates columns when it is the column separator too.
      push('separator', i + 1);
    } else if (
      ch === ';' ||
      (syntax.arrayColumn !== syntax.argumentSeparator && ch === syntax.arrayColumn)
    ) {
      push('arraySeparator', i + 1);
    } else if (isDigit(ch) || (ch === syntax.decimal && isDigit(text[i + 1]))) {
      // A row reference (`1:3`) or a number.
      const row = match(ROW, text, i);
      if (row >= 0) {
        push('ref', i + row);
        continue;
      }
      if (afterColon()) {
        const r = match(ROW_AFTER_COLON, text, i);
        if (r >= 0) {
          push('ref', i + r);
          continue;
        }
      }
      push('number', i + match(syntax.decimal === '.' ? NUMBER_DOT : NUMBER_COMMA, text, i));
    } else if (ch === '$' || isLetter(ch)) {
      const cell = match(CELL, text, i);
      const wordLen = Math.max(0, match(WORD, text, i));
      const column = match(COLUMN, text, i);
      if (wordLen > 0 && text[i + wordLen] === '!') {
        push('sheet', i + wordLen + 1);
      } else if (cell >= 0 && cell >= wordLen && !(text[i + cell] === '(')) {
        push('ref', i + cell);
      } else if (ch === '$' && isDigit(text[i + 1])) {
        push('ref', i + match(ABS_ROW, text, i));
      } else if (column >= 0 && (wordLen === 0 || column >= wordLen)) {
        push('ref', i + column);
      } else if (afterColon() && match(COLUMN_AFTER_COLON, text, i) >= 0) {
        push('ref', i + match(COLUMN_AFTER_COLON, text, i));
      } else if (wordLen > 0) {
        const upper = text.slice(i, i + wordLen).toUpperCase();
        let j = i + wordLen;
        while (isSpace(text[j])) j += 1;
        if (text[j] === '(') push('function', i + wordLen);
        else if (upper === 'TRUE' || upper === 'FALSE') push('bool', i + wordLen);
        else push('name', i + wordLen);
      } else push('unknown', i + 1);
    } else {
      const op = OPERATORS.find((o) => text.startsWith(o, i));
      if (op) push('operator', i + op.length);
      else push('unknown', i + 1);
    }
  }
  return tokens;
}
