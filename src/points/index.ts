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
import type { CodeOutput } from '../core/code.js';
import type { Zone } from '../core/zone.js';
import type { Reference, Value } from '../formula/values.js';
import type { ChartData, ChartSpec } from '../core/charts.js';
import type { CellsTheme } from '../render/theme.js';

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

/** A cell's rectangle in CSS px of the canvas, zoom applied; font sizes multiply by `zoom` to match. */
export interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
}

/**
 * What activating a cell type's cell does (a click in its hit area, or one of
 * its `activateOn` keys on the active cell): a command the grid dispatches
 * (undoable, refused by gates and read-only workbooks like any other), a URL
 * the grid opens in a new tab, or nothing.
 */
export type CellActivation =
  | { readonly command: { readonly type: string } & Record<string, unknown> }
  | { readonly open: string }
  | undefined
  | void;

/**
 * A cell type drawn on canvas: a checkbox, a link, a progress bar. A cell
 * takes a type through its style (`style.type` is the type's `id`, set with
 * `SET_STYLE` as any style property, persisted and synced with the style), so
 * a type applies per cell, row or column; a type no plugin contributes draws
 * as a plain value. A type contributes what it draws, how wide it wants to
 * be, what a click or a key does, and what a screen reader hears. Typing over
 * the cell edits its value as text, as for any cell, unless `editable` is
 * `false`.
 */
export interface CellType {
  readonly id: string;
  /** Draw the cell's value in its rectangle (already clipped to it); `style` is the cell's, `theme` the grid's, `cell` where it is. */
  render(
    ctx: CanvasRenderingContext2D,
    rect: CellRect,
    value: CellValue,
    style: Style,
    theme: CellsTheme,
    cell?: CellTypeCell,
  ): void;
  /** Drawn even with no value (a code cell not run yet shows its source). */
  readonly paintsEmpty?: boolean;
  /** The width the cell wants (`cells.fitColumns`), in px; `text` measures a string in the cell's font. */
  measure?(value: CellValue, style: Style, text: (s: string) => number): number | undefined;
  /** Whether a point of the cell (relative to its rectangle) activates it; the whole cell when absent and `activate` is given. */
  hitTest?(point: { x: number; y: number }, rect: { width: number; height: number }): boolean;
  /** A click in the hit area, or one of `activateOn` on the active cell. */
  activate?(
    cell: { sheet: string; row: number; col: number },
    value: CellValue,
    context: CommandContext,
  ): CellActivation;
  /** The keys (`KeyboardEvent.key`) that activate the active cell: `' '` for a checkbox, `'Enter'` for a link. */
  readonly activateOn?: readonly string[];
  /** `false`: typing over the cell does not open the editor (F2 still does). */
  readonly editable?: boolean;
  /** What a screen reader hears for the cell, instead of the value's text. */
  accessibleName?(value: CellValue, style: Style, cell?: CellTypeCell): string;
  /** A React component editing this type; typed loosely so the core needs no React. */
  readonly editor?: unknown;
}

/** Where a typed cell is, for a type that reads more than its value: the sheet, the position and the grid's `CellsModel`. */
export interface CellTypeCell {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  /** The `CellsModel` (typed loosely, as a render layer's). */
  readonly model: unknown;
}

/** What a render layer draws into: one pane of the viewport, clipped to it, in CSS px with the zoom applied. */
export interface RenderLayerView {
  readonly sheet: string;
  /** The rows and columns the pane shows. */
  readonly zone: Zone;
  readonly pane: 'corner' | 'top' | 'left' | 'main';
  readonly zoom: number;
  /** A cell's rectangle on the canvas. */
  cellRect(row: number, col: number): CellRect;
}

/**
 * A render layer (§3.3), drawn after the core layer of the same kind, once
 * per pane, in `order`: `background` after the fills and grid lines, `cells`
 * after the text and borders (both on the grid canvas, repainted with the
 * cells), `overlay` after the selection (on the overlay canvas, repainted on
 * every selection move). `model` is the `CellsModel` the grid draws.
 */
export interface RenderLayer {
  readonly id: string;
  readonly layer: 'background' | 'cells' | 'overlay';
  draw(ctx: CanvasRenderingContext2D, view: RenderLayerView, model: unknown): void;
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

/** What a kernel's run gives back (§3.13): nbformat outputs, and the execution count when the kernel says it. */
export interface KernelRun {
  readonly outputs: readonly CodeOutput[];
  readonly executionCount?: number;
}

/**
 * A kernel a code cell runs on (§3.13): Python code in, nbformat outputs out.
 * `./jupyter` adapts jupyter-react's kernels to it; a host may write its own.
 */
export interface CellsKernel {
  execute(code: string): Promise<KernelRun>;
  /** Stop the run in flight. */
  interrupt?(): Promise<void>;
  /** Start the kernel again. */
  restart?(): Promise<void>;
  /** Be told of the kernel's state (`idle`, `busy`, `starting`, `dead`…); returns the function that stops it. */
  onStatus?(listener: (status: string) => void): () => void;
}

/** What a code output renderer draws: a code cell's stored outputs, the cell's name, the frame's size. */
export interface CodeOutputRendererProps {
  readonly outputs: readonly CodeOutput[];
  /** The cell, as a person reads it: `B4`. */
  readonly cell: string;
  readonly width: number;
  readonly height: number;
  /** Whether the outputs were made here: untrusted ones come with their HTML, scripts and widgets already left out. */
  readonly trusted: boolean;
}

/** What a code editor renderer edits: the cell's source, the model to write back to, and how to close. */
export interface CodeEditorRendererProps {
  readonly sheet: string;
  readonly row: number;
  readonly col: number;
  /** The `CellsModel` (typed loosely, as a render layer's). */
  readonly model: unknown;
  /** Close the overlay (after saving, when the editor saves itself). */
  readonly onClose: () => void;
  /** Hand the overlay the editor's `save` (the source written back as one undo step), so closing it from outside saves too. */
  readonly register?: (controls: { readonly save: () => void }) => void;
}

/**
 * The React components code cells are shown and edited with
 * (`datalayer.cells.codeRenderer`, §3.13): `output` draws a cell's outputs
 * in its frame, `editor` is *Open in editor*. Typed loosely so the core
 * needs no React; `./jupyter` contributes jupyter-react's `Output` and `Cell`.
 */
export interface CodeRenderer {
  readonly id: string;
  readonly output: unknown;
  readonly editor?: unknown;
  /** A kernel indicator (`{ model }`): the overlay's header shows it beside the cell's address. */
  readonly status?: unknown;
}

/** A kernel provider (`datalayer.cells.kernel`): an id, a label, and how to connect, once, on a first run. */
export interface KernelProvider {
  readonly id: string;
  readonly label: string;
  connect(): Promise<CellsKernel>;
}

/** An ECharts option, typed loosely: the core never imports ECharts (§3.12). */
export type ChartOption = Record<string, unknown>;

/**
 * A chart type (§3.12): what it draws with (the ECharts modules `./charts`
 * registers when the type is resolved, so the built-ins never pull a radar
 * in), its option from a spec, its data and the theme (a pure function,
 * tested in Node), and its description for a screen reader. By id; a
 * duplicate is refused naming both plugins.
 */
export interface ChartType {
  readonly id: string;
  readonly label: string;
  readonly octicon?: string;
  /** The ECharts modules the type needs (`echarts.use`); typed loosely so the core imports no ECharts. */
  readonly modules: readonly unknown[];
  option(spec: ChartSpec, data: ChartData, theme: CellsTheme): ChartOption;
  describe(spec: ChartSpec, data: ChartData): string;
  /** How the type reads from and writes to DrawingML (C10-07); absent, the chart goes to the import report. */
  readonly xlsx?: { readonly read?: unknown; readonly write?: unknown };
}

/** A transform of every option (a house style, a number format, a watermark), applied after the type's `option`, in `order`. */
export interface ChartOptionTransform {
  readonly id: string;
  applies?(spec: ChartSpec): boolean;
  transform(option: ChartOption, spec: ChartSpec, theme: CellsTheme): ChartOption;
}

/** What the renderer draws: an option, the modules its type needs, and the frame's size. */
export interface ChartRendererProps {
  readonly option: ChartOption;
  readonly modules: readonly unknown[];
  readonly width: number;
  readonly height: number;
  readonly theme: CellsTheme;
}

/**
 * The one drawing of charts, contributed by `CellsChartsPlugin` (ECharts):
 * exactly one, or none, in which case a chart draws as a labelled
 * placeholder frame. The component is typed loosely so the core needs no React.
 */
export interface ChartRenderer {
  readonly id: string;
  readonly component: unknown;
}

/** A toolbar or menu entry, naming a Reactor command by id. */
export interface CommandItem {
  readonly command: string;
  readonly group?: string;
}

/** `datalayer.cells.patchOp`: how a change is applied and inverted, by op. */
export const CellsPatchOps = defineContributionPoint<PatchOp<any>>('datalayer.cells.patchOp');
/** `datalayer.cells.command`: the handlers of commands, by type. */
export const CellsCommands =
  defineContributionPoint<CommandHandler<any>>('datalayer.cells.command');
/** `datalayer.cells.function`: formula functions, by upper-case name. */
export const CellsFunctions = defineContributionPoint<FormulaFunction>('datalayer.cells.function');
/** `datalayer.cells.cellType`: cell types (checkbox, link, progress, a plugin's), by id. */
export const CellsCellTypes = defineContributionPoint<CellType>('datalayer.cells.cellType');
/** `datalayer.cells.renderLayer`: layers drawn after the core layer of their kind, in order. */
export const CellsRenderLayers = defineContributionPoint<RenderLayer>(
  'datalayer.cells.renderLayer',
);
/** `datalayer.cells.clipboard`: one clipboard handler per feature, in order. */
export const CellsClipboard = defineContributionPoint<ClipboardHandler>(
  'datalayer.cells.clipboard',
);
/** `datalayer.cells.fillRule`: fill-handle series rules, tried in order. */
export const CellsFillRules = defineContributionPoint<FillRule>('datalayer.cells.fillRule');
/** `datalayer.cells.importer`: file readers, by MIME type and extension. */
export const CellsImporters = defineContributionPoint<Importer>('datalayer.cells.importer');
/** `datalayer.cells.exporter`: file writers, by MIME type and extension. */
export const CellsExporters = defineContributionPoint<Exporter>('datalayer.cells.exporter');
/** `datalayer.cells.dataSource`: read-only paged sources of columns, by id. */
export const CellsDataSources = defineContributionPoint<DataSource>('datalayer.cells.dataSource');
/** `datalayer.cells.collabProvider`: the one collaboration provider, or none. */
export const CellsCollabProvider = defineContributionPoint<CollabProvider>(
  'datalayer.cells.collabProvider',
);
/** `datalayer.cells.codeRenderer`: how code outputs are drawn and sources edited; the first in `order` wins. */
export const CellsCodeRenderer = defineContributionPoint<CodeRenderer>(
  'datalayer.cells.codeRenderer',
);
/** `datalayer.cells.kernel`: the kernels code cells run on, by id (the first unless the host names one). */
export const CellsKernels = defineContributionPoint<KernelProvider>('datalayer.cells.kernel');
/** `datalayer.cells.toolbarItem`: the toolbar's entries, naming Reactor commands. */
export const CellsToolbarItems = defineContributionPoint<CommandItem>(
  'datalayer.cells.toolbarItem',
);
/** `datalayer.cells.menuItem`: the context menu's entries, naming Reactor commands. */
export const CellsMenuItems = defineContributionPoint<CommandItem>('datalayer.cells.menuItem');
/** `datalayer.cells.chartType`: chart types, by id. */
export const CellsChartTypes = defineContributionPoint<ChartType>('datalayer.cells.chartType');
/** `datalayer.cells.chartOption`: transforms of every chart option, in order. */
export const CellsChartOptions = defineContributionPoint<ChartOptionTransform>(
  'datalayer.cells.chartOption',
);
/** `datalayer.cells.chartRenderer`: the one component drawing charts, or none (placeholders). */
export const CellsChartRenderer = defineContributionPoint<ChartRenderer>(
  'datalayer.cells.chartRenderer',
);

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
  CellsChartTypes,
  CellsChartOptions,
  CellsChartRenderer,
  CellsEditGate,
  CellsKernels,
  CellsCodeRenderer,
] as const;

export {
  PointTable,
  firstContribution,
  optionalContribution,
  type CellsPlatform,
  type PointTableOptions,
  type Resolved,
} from './resolve.js';
