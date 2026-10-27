/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The formula parser: a Pratt parser with Excel's precedence. Refusals are
 * `FormulaSyntaxError`s carrying where in the text they are.
 *
 * Precedence, loosest first: comparisons (= <> < <= > >=), `&`, `+ -`,
 * `* /`, `^` (left-associative, as Excel), unary `-` `+` (tighter than `^`:
 * `-2^2` is 4), `%`, the space intersection, `:`.
 *
 * @module formula/parser
 */

import { columnIndex } from '../core/zone.js';
import { type CellErrorCode, isErrorCode } from '../core/values.js';
import type { Ast, RefPart } from './ast.js';
import { EN_US_SYNTAX, type FormulaSyntax, type Token, tokenize } from './tokens.js';

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    /** Where in the formula text, `[start, end)`. */
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

export interface Parsed {
  readonly ast: Ast;
  /** Every token, whitespace included: what the editor colours. */
  readonly tokens: readonly Token[];
}

const BINARY: Record<string, number> = {
  '=': 10,
  '<>': 10,
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '&': 20,
  '+': 30,
  '-': 30,
  '*': 40,
  '/': 40,
  '^': 50,
};
const UNARY = 60;
const PERCENT = 70;
const INTERSECT = 80;
const RANGE = 90;

const MAX_ROW = 1_048_576;
const MAX_COL = 16_384;

function refPart(text: string, start: number, end: number): RefPart {
  const m = /^(\$?)([A-Za-z]{1,3})?(\$?)([0-9]{1,7})?$/.exec(text);
  if (!m || (m[2] === undefined && m[4] === undefined))
    throw new FormulaSyntaxError(`'${text}' is not a reference.`, start, end);
  const part: { row?: number; col?: number; rowAbs: boolean; colAbs: boolean } = {
    rowAbs: false,
    colAbs: false,
  };
  if (m[2] !== undefined) {
    part.col = columnIndex(m[2]);
    part.colAbs = m[1] === '$';
    if (part.col >= MAX_COL)
      throw new FormulaSyntaxError(`'${text}' is past the last column, XFD.`, start, end);
    if (m[4] !== undefined) {
      part.rowAbs = m[3] === '$';
      part.row = Number(m[4]) - 1;
    }
  } else {
    part.rowAbs = m[1] === '$' || m[3] === '$';
    part.row = Number(m[4]) - 1;
  }
  if (part.row !== undefined && (part.row < 0 || part.row >= MAX_ROW)) {
    throw new FormulaSyntaxError(`'${text}' is outside rows 1 to ${MAX_ROW}.`, start, end);
  }
  return part;
}

function sheetName(text: string): string {
  const name = text.slice(0, -1);
  return name.startsWith("'") ? name.slice(1, -1).replace(/''/g, "'") : name;
}

class Parser {
  readonly #tokens: Token[];
  readonly #text: string;
  readonly #syntax: FormulaSyntax;
  #i = 0;

  constructor(text: string, tokens: Token[], syntax: FormulaSyntax) {
    this.#text = text;
    this.#tokens = tokens;
    this.#syntax = syntax;
  }

  parse(): Ast {
    this.#skipSpace();
    if (this.#i >= this.#tokens.length)
      throw new FormulaSyntaxError('The formula is empty.', 0, this.#text.length);
    const ast = this.#expression(0);
    this.#skipSpace();
    const t = this.#tokens[this.#i];
    if (t !== undefined) {
      throw new FormulaSyntaxError(
        t.kind === 'rparen'
          ? 'A closing parenthesis has no opening one.'
          : `Unexpected '${t.text}'.`,
        t.start,
        t.end,
      );
    }
    return ast;
  }

  /** The next token past any whitespace, consuming the whitespace. */
  #peek(): Token | undefined {
    this.#skipSpace();
    return this.#tokens[this.#i];
  }

  /** The next token past any whitespace, and its index, consuming nothing. */
  #lookahead(): { token: Token | undefined; at: number } {
    let at = this.#i;
    while (this.#tokens[at]?.kind === 'whitespace') at += 1;
    return { token: this.#tokens[at], at };
  }

  #skipSpace(): void {
    while (this.#tokens[this.#i]?.kind === 'whitespace') this.#i += 1;
  }

  /** A space between two operands is the intersection operator; elsewhere it is nothing. */
  #spaceIsIntersection(): boolean {
    const t = this.#tokens[this.#i];
    if (t?.kind !== 'whitespace') return false;
    const next = this.#tokens[this.#i + 1];
    return (
      next !== undefined &&
      (next.kind === 'ref' ||
        next.kind === 'sheet' ||
        next.kind === 'name' ||
        next.kind === 'lparen' ||
        next.kind === 'function')
    );
  }

  #expression(minPower: number): Ast {
    let left = this.#prefix();
    for (;;) {
      if (this.#spaceIsIntersection() && INTERSECT > minPower && this.#isReference(left)) {
        this.#i += 1;
        const right = this.#expression(INTERSECT);
        left = { type: 'binary', op: ' ', left, right };
        continue;
      }
      const { token: t, at } = this.#lookahead();
      if (t === undefined || t.kind !== 'operator') break;
      if (t.text === '%') {
        if (PERCENT <= minPower) break;
        this.#i = at + 1;
        left = { type: 'percent', arg: left };
        continue;
      }
      if (t.text === ':') {
        if (RANGE <= minPower) break;
        this.#i = at + 1;
        const right = this.#expression(RANGE);
        left = this.#range(left, right, t);
        continue;
      }
      const power = BINARY[t.text];
      if (power === undefined || power <= minPower) break;
      this.#i = at + 1;
      const right = this.#expression(power);
      left = { type: 'binary', op: t.text as never, left, right };
    }
    return left;
  }

  #isReference(a: Ast): boolean {
    return (
      a.type === 'cell' ||
      a.type === 'range' ||
      a.type === 'name' ||
      a.type === 'union' ||
      (a.type === 'binary' && a.op === ' ') ||
      a.type === 'call'
    );
  }

  #range(left: Ast, right: Ast, at: Token): Ast {
    const end = (a: Ast): { sheet?: string; part: RefPart } | undefined =>
      a.type === 'cell' ? { sheet: a.sheet, part: a.ref } : undefined;
    const l = end(left);
    const r = end(right);
    if (l && r) {
      if (r.sheet !== undefined && r.sheet !== l.sheet) {
        throw new FormulaSyntaxError('A range lies on one sheet.', at.start, at.end);
      }
      const whole = (p: RefPart) =>
        p.row === undefined ? 'cols' : p.col === undefined ? 'rows' : 'cells';
      if (whole(l.part) !== whole(r.part))
        throw new FormulaSyntaxError(
          'Both ends of a range are cells, columns or rows alike.',
          at.start,
          at.end,
        );
      return { type: 'range', sheet: l.sheet, from: l.part, to: r.part };
    }
    // A range between computed references (INDEX(…):B9) is the range operator over references.
    if (this.#isReference(left) && this.#isReference(right))
      return { type: 'call', name: ':', args: [left, right] };
    throw new FormulaSyntaxError("':' joins two references.", at.start, at.end);
  }

  #prefix(): Ast {
    const t = this.#peek();
    if (t === undefined) {
      throw new FormulaSyntaxError(
        'The formula ends where a value was expected.',
        this.#text.length,
        this.#text.length,
      );
    }
    this.#i += 1;
    switch (t.kind) {
      case 'number': {
        const n = Number(t.text.replace(this.#syntax.decimal, '.'));
        if (!Number.isFinite(n))
          throw new FormulaSyntaxError(`'${t.text}' is not a number.`, t.start, t.end);
        return { type: 'number', value: n };
      }
      case 'string':
        if (!/^"(?:[^"]|"")*"$/.test(t.text))
          throw new FormulaSyntaxError(
            'A text opens a quote it never closes.',
            t.start,
            this.#text.length,
          );
        return { type: 'string', value: t.text.slice(1, -1).replace(/""/g, '"') };
      case 'bool':
        return { type: 'bool', value: t.text.toUpperCase() === 'TRUE' };
      case 'error': {
        const code = t.text.toUpperCase();
        if (!isErrorCode(code))
          throw new FormulaSyntaxError(`'${t.text}' is not an error value.`, t.start, t.end);
        return { type: 'error', code: code as CellErrorCode };
      }
      case 'sheet': {
        const next = this.#tokens[this.#i];
        if (next?.kind !== 'ref')
          throw new FormulaSyntaxError(`A reference follows ${t.text}.`, t.start, t.end);
        this.#i += 1;
        return {
          type: 'cell',
          sheet: sheetName(t.text),
          ref: refPart(next.text, next.start, next.end),
        };
      }
      case 'ref':
        return { type: 'cell', ref: refPart(t.text, t.start, t.end) };
      case 'name':
        return { type: 'name', name: t.text };
      case 'function':
        return this.#call(t);
      case 'operator':
        if (t.text === '-' || t.text === '+') {
          const arg = this.#expression(UNARY);
          return { type: 'unary', op: t.text, arg };
        }
        throw new FormulaSyntaxError(`'${t.text}' needs a value before it.`, t.start, t.end);
      case 'lparen': {
        const first = this.#expression(0);
        const items = [first];
        while (this.#peek()?.kind === 'separator') {
          this.#i += 1;
          items.push(this.#expression(0));
        }
        const close = this.#peek();
        if (close?.kind !== 'rparen') {
          throw new FormulaSyntaxError(
            'A parenthesis is never closed.',
            t.start,
            close?.start ?? this.#text.length,
          );
        }
        this.#i += 1;
        if (items.length === 1) return first;
        if (!items.every((a) => this.#isReference(a))) {
          throw new FormulaSyntaxError('A union joins references only.', t.start, close.end);
        }
        return { type: 'union', items };
      }
      case 'lbrace':
        return this.#array(t);
      case 'rparen':
        throw new FormulaSyntaxError('A closing parenthesis has no opening one.', t.start, t.end);
      default:
        throw new FormulaSyntaxError(`Unexpected '${t.text}'.`, t.start, t.end);
    }
  }

  #call(name: Token): Ast {
    const open = this.#peek();
    if (open?.kind !== 'lparen')
      throw new FormulaSyntaxError(`${name.text} is called with ( ).`, name.start, name.end);
    this.#i += 1;
    const args: Ast[] = [];
    const closeOrSep = () => {
      const t = this.#peek();
      return t?.kind === 'rparen' || t?.kind === 'separator';
    };
    if (this.#peek()?.kind !== 'rparen') {
      for (;;) {
        args.push(closeOrSep() ? { type: 'empty' } : this.#expression(0));
        const t = this.#peek();
        if (t?.kind === 'separator') {
          this.#i += 1;
          if (this.#peek()?.kind === 'rparen') args.push({ type: 'empty' });
          continue;
        }
        break;
      }
    }
    const close = this.#peek();
    if (close?.kind !== 'rparen') {
      throw new FormulaSyntaxError(
        `${name.text}( is never closed.`,
        name.start,
        close?.start ?? this.#text.length,
      );
    }
    this.#i += 1;
    return { type: 'call', name: name.text.toUpperCase(), args };
  }

  #array(open: Token): Ast {
    const rows: Ast[][] = [[]];
    for (;;) {
      const t = this.#peek();
      if (t === undefined)
        throw new FormulaSyntaxError('An array is never closed.', open.start, this.#text.length);
      if (t.kind === 'rbrace') {
        this.#i += 1;
        break;
      }
      if (
        // The argument separator separates columns, unless it is `;`, which separates rows everywhere.
        (t.kind === 'separator' && this.#syntax.argumentSeparator !== ';') ||
        (t.kind === 'arraySeparator' && t.text === this.#syntax.arrayColumn)
      ) {
        this.#i += 1;
        continue;
      }
      if (t.kind === 'arraySeparator' || t.kind === 'separator') {
        this.#i += 1;
        rows.push([]);
        continue;
      }
      const item = this.#prefix();
      const constant =
        item.type === 'number' ||
        item.type === 'string' ||
        item.type === 'bool' ||
        item.type === 'error' ||
        (item.type === 'unary' && item.arg.type === 'number');
      if (!constant) throw new FormulaSyntaxError('An array holds constants only.', t.start, t.end);
      rows[rows.length - 1].push(item);
    }
    const width = rows[0].length;
    if (width === 0 || rows.some((r) => r.length !== width)) {
      throw new FormulaSyntaxError(
        'Every row of an array has the same number of values.',
        open.start,
        open.end,
      );
    }
    return { type: 'array', rows };
  }
}

/** Parse a formula's text (without its `=`). Throws a FormulaSyntaxError with the position of what is wrong. */
export function parseFormula(text: string, syntax: FormulaSyntax = EN_US_SYNTAX): Parsed {
  const tokens = tokenize(text, syntax);
  const unknown = tokens.find((t) => t.kind === 'unknown');
  if (unknown)
    throw new FormulaSyntaxError(
      `'${unknown.text}' is not part of a formula.`,
      unknown.start,
      unknown.end,
    );
  return { ast: new Parser(text, tokens, syntax).parse(), tokens };
}
