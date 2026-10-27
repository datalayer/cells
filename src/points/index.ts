/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The Reactor contribution points of Cells, and what each takes.
 *
 * Every extension of Cells is a contribution to one of these points, from a
 * Reactor plugin (`definePlugin` from `@datalayer/reactor`); the built-in
 * features contribute through the same points. The ids are the contract
 * between plugins: `datalayer.cells.*`.
 *
 * @module points
 */

import { defineContributionPoint, defineGate } from '@datalayer/reactor';
import type { CommandContext, CommandResult } from '../core/commands.js';
import type { Patch, PatchOp } from '../core/patches.js';
import type { PasteOptions, Slice } from '../core/clipboard.js';
import type { Style } from '../core/styles.js';
import type { CellValue } from '../core/values.js';
import type { Zone } from '../core/zone.js';
import type { Reference, Value } from '../formula/values.js';

export type { PatchOp } from '../core/patches.js';

/** A command handler: refuses with reasons, or turns a command into patches. */
export interface CommandHandler<
  C extends { type: string } = { type: string } & Record<string, unknown>,
> {
  readonly type: C['type'];
  /** Refusals with reasons; omitted means always allowed. */
  allow?(context: CommandContext, command: C): CommandResult;
  /** The patches that perform the command, computed from the current state; applied in order. */
  apply(context: CommandContext, command: C): Patch[];
  /** F4 when not editing: the same command at a new selection (§3.2). */
  repeat?(command: C, selection: { sheet: string; zones: readonly Zone[] }): C | undefined;
}

/**
 * An argument of a formula function, as the evaluator passes it and as
 * autocomplete describes it:
 * - `scalar`: one value, a reference read (a range by implicit intersection);
 *   an error stops the call and becomes its result;
 * - `range`: the reference or array as it is (aggregates read it lazily);
 * - `any`: the value as it is, errors included (ISERROR, IFERROR's first);
 * - `lazy`: a function computing the value when called (IF's branches).
 */
export interface FunctionArgument {
  readonly name: string;
  readonly type: 'scalar' | 'range' | 'any' | 'lazy';
  readonly optional?: boolean;
  /** The last argument repeats (SUM(number1, number2, …)). */
  readonly repeating?: boolean;
  readonly description?: string;
}

/** What a function reads beyond its arguments: where it is, the cells of a reference, the time. */
export interface FunctionContext {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  /** A reference's values as rows (formulas evaluated). */
  read(ref: Reference): CellValue[][];
  /** Every value of a reference or array that holds something, in row order within each column; empty cells skipped. */
  values(range: Value): Iterable<CellValue>;
  /** The value of one cell. */
  cell(sheet: string, row: number, col: number): CellValue;
  /** A reference clipped to the rows and columns that hold something (at least its first cell). */
  extent(ref: Reference): Reference;
  /** A sheet's id by its name, or `undefined`. */
  sheetByName(name: string): string | undefined;
  /** The size of a sheet. */
  limits(sheet: string): { rows: number; cols: number };
}

/** A formula function (§3.4). */
export interface FormulaFunction {
  /** Upper-case, as typed: `SUM`, `XLOOKUP`. */
  readonly name: string;
  readonly args: readonly FunctionArgument[];
  readonly returns: 'number' | 'string' | 'boolean' | 'any' | 'reference';
  /** The function: may throw an error value (`fail('#VALUE!')`); returns a value, a reference or an array. */
  readonly compute: (
    args: readonly unknown[],
    context: FunctionContext,
  ) => Value | Promise<CellValue>;
  /** Recomputed on every recalculation (NOW, RAND, OFFSET, INDIRECT). */
  readonly volatile?: boolean;
  readonly async?: boolean;
  readonly category:
    'math' | 'statistics' | 'logic' | 'text' | 'lookup' | 'date' | 'information' | 'other';
  readonly description: string;
  /** Formulas showing it, each `=…` with what it gives: `=ROUND(2.567, 2)` → 2.57. */
  readonly examples: readonly string[];
}

/** A cell type drawn on canvas: a checkbox, a link, a progress bar. */
export interface CellType {
  readonly id: string;
  render(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
    value: CellValue,
    style: Style,
    theme: Readonly<Record<string, unknown>>,
  ): void;
  hitTest?(point: { x: number; y: number }, rect: { width: number; height: number }): boolean;
  onClick?(cell: { sheet: string; row: number; col: number }, value: CellValue): Patch[] | void;
  /** A React component editing this type; typed loosely so the core needs no React. */
  readonly editor?: unknown;
  accessibleName?(value: CellValue): string;
}

/** A render layer, drawn after the core layers of the same kind (§3.3). */
export interface RenderLayer {
  readonly id: string;
  readonly layer: 'background' | 'cells' | 'overlay';
  draw(
    ctx: CanvasRenderingContext2D,
    viewport: { sheet: string; zone: Zone },
    model: unknown,
  ): void;
}

/**
 * A clipboard handler: one per feature (cells, merges, sizes, a plugin's own),
 * so a new feature brings its own copy and paste. `copy` returns its part of
 * a slice (or `undefined` for nothing); `paste` turns that part into patches.
 */
export interface ClipboardHandler {
  readonly id: string;
  copy(context: CommandContext, sheet: string, zone: Zone): unknown;
  paste(
    context: CommandContext,
    sheet: string,
    part: unknown,
    target: Zone,
    options: PasteOptions,
    /** Where the slice was copied from, when it says: a copied formula's references move by the distance. */
    source?: Slice['source'],
  ): Patch[];
}

/** A fill-handle series rule (§3.5). */
/** A cell the fill handle extends from: its value, and its number format (dates are numbers with a date format). */
export interface FillSource {
  readonly value: CellValue;
  readonly format?: string;
}

/**
 * A fill-handle series rule (§3.5): `match` reads the cells dragged from and
 * returns a series, or `undefined` when the rule does not apply; `next` gives
 * the value at an index past the source (0 is the first filled cell; negative
 * indexes fill backwards, up or left). Rules are tried in order; the first
 * that matches extends the series.
 */
export interface FillRule {
  readonly id: string;
  match(source: readonly FillSource[]): unknown | undefined;
  next(series: unknown, index: number): CellValue;
}

/** Reads a file format into the native format (`CellsWorkbook`). */
export interface Importer {
  readonly id: string;
  readonly mime: string;
  readonly extensions: readonly string[];
  read(input: ReadableStream<Uint8Array> | Uint8Array | string): Promise<unknown>;
}

/** Writes a workbook out. */
export interface Exporter {
  readonly id: string;
  readonly mime: string;
  readonly extension: string;
  write(model: unknown): Promise<Blob | Uint8Array | string>;
}

/** A read-only, paged virtual source of columns (§3.11). */
export interface DataSource {
  readonly id: string;
  readonly rowCount: number;
  readonly columns: readonly { readonly name: string; readonly type?: string }[];
  fetch(rows: { from: number; to: number }): Promise<readonly (readonly CellValue[])[]>;
}

/** The collaboration provider: exactly one, or none for "collaboration off" (§3.9). */
export interface CollabProvider {
  readonly id: string;
  connect(doc: unknown, room: string): unknown;
}

/** A toolbar or menu entry, naming a Reactor command by id. */
export interface CommandItem {
  readonly command: string;
  readonly group?: string;
}

export const CellsPatchOps = defineContributionPoint<PatchOp<any>>('datalayer.cells.patchOp');
export const CellsCommands =
  defineContributionPoint<CommandHandler<any>>('datalayer.cells.command');
export const CellsFunctions = defineContributionPoint<FormulaFunction>('datalayer.cells.function');
export const CellsCellTypes = defineContributionPoint<CellType>('datalayer.cells.cellType');
export const CellsRenderLayers = defineContributionPoint<RenderLayer>(
  'datalayer.cells.renderLayer',
);
export const CellsClipboard = defineContributionPoint<ClipboardHandler>(
  'datalayer.cells.clipboard',
);
export const CellsFillRules = defineContributionPoint<FillRule>('datalayer.cells.fillRule');
export const CellsImporters = defineContributionPoint<Importer>('datalayer.cells.importer');
export const CellsExporters = defineContributionPoint<Exporter>('datalayer.cells.exporter');
export const CellsDataSources = defineContributionPoint<DataSource>('datalayer.cells.dataSource');
export const CellsCollabProvider = defineContributionPoint<CollabProvider>(
  'datalayer.cells.collabProvider',
);
export const CellsToolbarItems = defineContributionPoint<CommandItem>(
  'datalayer.cells.toolbarItem',
);
export const CellsMenuItems = defineContributionPoint<CommandItem>('datalayer.cells.menuItem');

/** What an edit gate is asked about: may this command apply? */
export interface EditGateContext {
  readonly command: { readonly type: string };
  readonly context: CommandContext;
}

/** A plugin may veto a command before it applies; the veto is a refusal with the gate's reason. */
export const CellsEditGate = defineGate<EditGateContext>('datalayer.cells.gate.edit');

/** Every point Cells opens, as `CellsCorePlugin` declares them. */
export const CELLS_POINTS = [
  CellsPatchOps,
  CellsCommands,
  CellsFunctions,
  CellsCellTypes,
  CellsRenderLayers,
  CellsClipboard,
  CellsFillRules,
  CellsImporters,
  CellsExporters,
  CellsDataSources,
  CellsCollabProvider,
  CellsToolbarItems,
  CellsMenuItems,
  CellsEditGate,
] as const;

export {
  PointTable,
  firstContribution,
  optionalContribution,
  type CellsPlatform,
  type PointTableOptions,
  type Resolved,
} from './resolve.js';
