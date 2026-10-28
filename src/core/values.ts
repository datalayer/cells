/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Cell values and errors.
 *
 * @module core/values
 */

/** The errors a cell can hold, as Excel spells them (`#CYCLE!`, `#BUSY!` and `#ERROR!` are ours). */
export const CELL_ERRORS = [
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
  '#ERROR!',
] as const;

/** An error a cell can show: `#DIV/0!`, `#REF!`, `#NAME?`, `#VALUE!`, `#N/A`, `#NUM!`, `#NULL!`, `#CYCLE!`, `#BUSY!`, `#SPILL!`, `#ERROR!` (a code cell's run raised). */
export type CellErrorCode = (typeof CELL_ERRORS)[number];

/** An error value, with an optional sentence saying why (shown in the cell's tooltip). */
export interface CellError {
  readonly error: CellErrorCode;
  readonly message?: string;
}

/** What a cell evaluates to. `null` is empty. */
export type CellValue = number | string | boolean | CellError | null;

const ERROR_SET: ReadonlySet<string> = new Set(CELL_ERRORS);

/** An error value; refuses a code that is not one of {@link CELL_ERRORS}. */
export function cellError(code: CellErrorCode, message?: string): CellError {
  if (!ERROR_SET.has(code))
    throw new Error(`'${code}' is not a cell error; there are ${CELL_ERRORS.join(' ')}.`);
  return message === undefined ? { error: code } : { error: code, message };
}

/** Whether a value is a cell error. */
export function isCellError(value: unknown): value is CellError {
  return (
    typeof value === 'object' &&
    value !== null &&
    ERROR_SET.has((value as { error?: unknown }).error as string)
  );
}

/** Whether a string is one of the error codes. */
export function isErrorCode(text: string): text is CellErrorCode {
  return ERROR_SET.has(text);
}
