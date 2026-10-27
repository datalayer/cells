/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The formula AST. References keep their absolute (`$`) flags and are
 * positions as written (A1); the compiler turns them relative to the cell
 * (R1C1) for the shape cache.
 *
 * @module formula/ast
 */

import type { CellErrorCode } from '../core/values.js';

/** One end of a reference: a row, a column, or both, each absolute or relative. */
export interface RefPart {
  readonly row?: number;
  readonly col?: number;
  readonly rowAbs: boolean;
  readonly colAbs: boolean;
}

export type Ast =
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'error'; readonly code: CellErrorCode }
  /** A cell. */
  | { readonly type: 'cell'; readonly sheet?: string; readonly ref: RefPart }
  /** A range: cells (`A1:B2`), whole columns (`A:C`) or whole rows (`1:3`). */
  | {
      readonly type: 'range';
      readonly sheet?: string;
      readonly from: RefPart;
      readonly to: RefPart;
    }
  | { readonly type: 'name'; readonly name: string }
  | { readonly type: 'call'; readonly name: string; readonly args: readonly Ast[] }
  | { readonly type: 'unary'; readonly op: '-' | '+'; readonly arg: Ast }
  | { readonly type: 'percent'; readonly arg: Ast }
  | {
      readonly type: 'binary';
      readonly op: '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=' | ' ';
      readonly left: Ast;
      readonly right: Ast;
    }
  /** A union of references: `(A1:B2,D4)`. */
  | { readonly type: 'union'; readonly items: readonly Ast[] }
  /** An array constant: `{1,2;3,4}`. */
  | { readonly type: 'array'; readonly rows: readonly (readonly Ast[])[] }
  /** An omitted argument: `IF(A1,,2)`. */
  | { readonly type: 'empty' };
