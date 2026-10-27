/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FormulaSyntaxError, parseFormula } from '../parser.js';
import { tokenize } from '../tokens.js';

const CASES = (
  JSON.parse(
    readFileSync(new URL('../../../tests/formula/cases.json', import.meta.url), 'utf8'),
  ) as {
    cases: { fn: string; formula: string }[];
  }
).cases;

describe('the formula parser', () => {
  it.each(CASES.map((c) => c.formula))('parses %s', (formula) => {
    expect(() => parseFormula(formula)).not.toThrow();
  });

  it("follows Excel's precedence", () => {
    expect(parseFormula('1+2*3').ast).toMatchObject({
      type: 'binary',
      op: '+',
      right: { type: 'binary', op: '*' },
    });
    // Negation binds tighter than ^: -2^2 is (-2)^2.
    expect(parseFormula('-2^2').ast).toMatchObject({
      type: 'binary',
      op: '^',
      left: { type: 'unary', op: '-' },
    });
    // ^ is left-associative: 2^3^2 is (2^3)^2.
    expect(parseFormula('2^3^2').ast).toMatchObject({
      type: 'binary',
      op: '^',
      left: { type: 'binary', op: '^' },
    });
    expect(parseFormula('5%*2').ast).toMatchObject({
      type: 'binary',
      op: '*',
      left: { type: 'percent' },
    });
    expect(parseFormula('1&2=12').ast).toMatchObject({ type: 'binary', op: '=' });
  });

  it('reads references: anchors, ranges, whole columns and rows, sheets, intersections, unions', () => {
    expect(parseFormula('$B$3').ast).toEqual({
      type: 'cell',
      ref: { row: 2, col: 1, rowAbs: true, colAbs: true },
    });
    expect(parseFormula('B$3:$C4').ast).toEqual({
      type: 'range',
      from: { row: 2, col: 1, rowAbs: true, colAbs: false },
      to: { row: 3, col: 2, rowAbs: false, colAbs: true },
    });
    expect(parseFormula('A:C').ast).toMatchObject({
      type: 'range',
      from: { col: 0 },
      to: { col: 2 },
    });
    expect(parseFormula('$2:5').ast).toMatchObject({
      type: 'range',
      from: { row: 1, rowAbs: true },
      to: { row: 4 },
    });
    expect(parseFormula("'My sheet'!A1:B2").ast).toMatchObject({
      type: 'range',
      sheet: 'My sheet',
    });
    expect(parseFormula('Data!A1').ast).toMatchObject({ type: 'cell', sheet: 'Data' });
    expect(parseFormula('A1:B3 B2:C4').ast).toMatchObject({ type: 'binary', op: ' ' });
    expect(parseFormula('SUM((A1,B2))').ast).toMatchObject({
      type: 'call',
      args: [{ type: 'union' }],
    });
  });

  it('reads calls, omitted arguments, arrays and names', () => {
    expect(parseFormula('if(A1,,2)').ast).toEqual({
      type: 'call',
      name: 'IF',
      args: [
        { type: 'cell', ref: { row: 0, col: 0, rowAbs: false, colAbs: false } },
        { type: 'empty' },
        { type: 'number', value: 2 },
      ],
    });
    expect(parseFormula('{1,2;3,-4}').ast).toMatchObject({
      type: 'array',
      rows: [
        [{}, {}],
        [{}, { type: 'unary' }],
      ],
    });
    expect(parseFormula('TaxRate*2').ast).toMatchObject({
      type: 'binary',
      left: { type: 'name', name: 'TaxRate' },
    });
    expect(parseFormula('LOG10(100)').ast).toMatchObject({ type: 'call', name: 'LOG10' });
    expect(parseFormula('"say ""hi"""').ast).toEqual({ type: 'string', value: 'say "hi"' });
  });

  it("reads a locale's separators", () => {
    const syntax = { argumentSeparator: ';', decimal: ',', arrayColumn: '\\' } as const;
    expect(parseFormula('ROUND(2,5;0)', syntax).ast).toMatchObject({
      type: 'call',
      args: [{ value: 2.5 }, { value: 0 }],
    });
    expect(parseFormula('{1\\2;3\\4}', syntax).ast).toMatchObject({
      type: 'array',
      rows: [
        [{}, {}],
        [{}, {}],
      ],
    });
  });

  it('gives the tokens the editor colours', () => {
    expect(tokenize('SUM(A1:B2, "x")').map((t) => t.kind)).toEqual([
      'function',
      'lparen',
      'ref',
      'operator',
      'ref',
      'separator',
      'whitespace',
      'string',
      'rparen',
    ]);
  });

  const MALFORMED: [string, RegExp, number][] = [
    ['', /empty/, 0],
    ['1+', /ends where a value was expected/, 2],
    ['SUM(1,2', /SUM\( is never closed/, 0],
    ['(1+2', /parenthesis is never closed/, 0],
    ['1+2)', /closing parenthesis has no opening one/, 3],
    ['"abc', /quote it never closes/, 0],
    ['1 + @', /'@' is not part of a formula/, 4],
    ['A1048577', /outside rows 1 to 1048576/, 0],
    ['XFE1', /past the last column/, 0],
    ['{1,2;3}', /same number of values/, 0],
    ['{1,A1}', /constants only/, 3],
    ['*2', /needs a value before it/, 0],
    ['A1:B', /cells, columns or rows alike/, 2],
    ['Sheet1!', /A reference follows/, 0],
    ['(1,2)', /union joins references only/, 0],
    ['#FOO!', /'#' is not part of a formula/, 0],
  ];

  it.each(MALFORMED)('refuses %s with the position of what is wrong', (formula, message, start) => {
    let error: unknown;
    try {
      parseFormula(formula);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FormulaSyntaxError);
    expect((error as FormulaSyntaxError).message).toMatch(message);
    expect((error as FormulaSyntaxError).start).toBe(start);
  });
});
